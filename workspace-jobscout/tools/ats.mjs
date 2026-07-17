#!/usr/bin/env node
// Direct ATS (career-page) job discovery — polls each company on the person's
// watchlist (people/<id>/company-watchlist.json) via the platform's public JSON
// endpoint (Comeet / Greenhouse / Lever / Ashby / BambooHR — no auth, no quota),
// and prints the same JSON shape as search.mjs / linkedin.mjs so the scout
// pipeline consumes it unchanged. This is the "under the radar" source: postings
// go up on the company's own careers page before (or without) LinkedIn/boards.
//
// Usage: node ats.mjs --person <id> [--window-days N] [--no-persist]
//   First run = backfill (mark all seen; report only fresh postings).
//   Later runs = incremental (report never-seen position ids, fresh-filtered).
//   --no-persist = read-only deep scan: no state write, already-seen included.
import { evaluateLocation } from './lib/location-filter.mjs';
import { titleHardExcluded, titleSignalsAutomation } from './lib/linkedin.mjs';
import {
  endpoints, normalizers, comeetCareersPageUrl, extractComeetToken,
  validateWatchlist, freshEnough, pruneSeenIds, foreignLocation, isRepost,
} from './lib/ats.mjs';
import { personIdFromArgv, failJson as fail, readJsonSafe } from './lib/cli.mjs';
import { writeJsonAtomic } from '../../shared/lib/fs-atomic.mjs';
import { loadPersonContext } from './lib/person-config.mjs';
import { todayInTz } from '../../shared/lib/time.mjs';

const FRESH_DAYS = 30;        // default reporting window for `updated` stamps
const SEEN_CAP = 10000;
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 4;        // companies fetched in parallel — gentle on the platforms
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function numFlag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
const fetchJson = async (url) => JSON.parse(await fetchText(url));

// Workday's CXS list endpoint is POST-only. One page of 20 per fetch; paginate to PAGES_MAX
// so a big tenant (NVIDIA: 400+ Israel hits) still surfaces its QA roles without hammering.
async function fetchWorkday(company) {
  const url = endpoints.workday(company);
  const PAGES_MAX = 5;
  const all = [];
  for (let page = 0; page < PAGES_MAX; page++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText: company.search || 'Israel' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const rows = json?.jobPostings || [];
      all.push(...rows);
      if (rows.length < 20) break;
    } catch (e) {
      // Per-page failure: keep the pages we already fetched instead of failing the whole
      // company. A mid-pagination network error on page N would otherwise discard pages
      // 0..N-1's rows, and those lost rows later resurface as spurious "new" candidates.
      // Page-0 failure returns [] (behaves like a no-rows company) and self-heals next run.
      process.stderr.write(`[ats.mjs] workday/${company.slug} page ${page} failed: ${e.message} — returning ${all.length} rows fetched so far\n`);
      break;
    } finally { clearTimeout(t); }
  }
  return { jobPostings: all };
}

// Comeet needs a per-company token scraped from its hosted careers page. Tokens are
// long-lived, so we cache them in the state file and only re-scrape when the API call
// fails (expired/rotated token) — one extra page fetch per company per rotation.
async function fetchComeet(company, tokenCache) {
  const cached = tokenCache[company.slug];
  if (cached) {
    try { return await fetchJson(endpoints.comeet(company, cached)); }
    catch { /* fall through to re-scrape */ }
  }
  const token = extractComeetToken(await fetchText(comeetCareersPageUrl(company)));
  if (!token) throw new Error('no token on careers page');
  tokenCache[company.slug] = token;
  return fetchJson(endpoints.comeet(company, token));
}

async function fetchCompany(company, tokenCache) {
  const raw = company.ats === 'comeet'
    ? await fetchComeet(company, tokenCache)
    : company.ats === 'workday'
      ? await fetchWorkday(company)
      : company.ats === 'getro'
        ? await fetchText(endpoints.getro(company)) // sitemap XML, not JSON
        : await fetchJson(endpoints[company.ats](company));
  return normalizers[company.ats](raw, company);
}

async function main() {
  const personId = personIdFromArgv();
  const { person, sources, locFilter } = loadPersonContext(personId, { sources: true, locationFilter: true });

  // No watchlist for this person (e.g. a fresh guest) → skip cleanly, like linkedin.mjs
  // does for missing keywords. Seed people/<id>/company-watchlist.json to enable.
  const watchlistJson = readJsonSafe(person.paths.watchlist, null);
  if (!watchlistJson) { console.log(JSON.stringify({ ok: true, count: 0, candidates: [], skipped: 'no-watchlist' })); return; }
  const { companies, invalid } = validateWatchlist(watchlistJson);
  for (const c of invalid) process.stderr.write(`[ats.mjs] invalid watchlist entry skipped: ${JSON.stringify(c)}\n`);
  if (companies.length === 0) { console.log(JSON.stringify({ ok: true, count: 0, candidates: [], skipped: 'empty-watchlist' })); return; }

  const deepDays = numFlag('--window-days');
  const noPersist = process.argv.includes('--no-persist');
  const freshDays = deepDays || FRESH_DAYS;
  // Same per-person title filter the LinkedIn source uses (junior/management/off-field) —
  // one criteria source of truth per person, whatever the job's origin.
  const titleFilter = sources?.linkedin?.title_filter || {};

  const STATE_PATH = person.paths.atsSeen;
  const state = readJsonSafe(STATE_PATH, {}) || {};
  const seenSet = new Set(state.seen_ids || []);
  const isBackfill = !state.backfilled;
  const tokenCache = state.comeet_tokens || {};
  const seenUpdated = state.seen_updated || {}; // external_id -> last surfaced `updated` stamp

  const runSeen = [];
  const candidates = [];
  let failed = 0;
  let droppedTitle = 0;
  let droppedForeign = 0;

  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const batch = companies.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (c) => {
      try { return await fetchCompany(c, tokenCache); }
      catch (e) { failed++; process.stderr.write(`[ats.mjs] ${c.ats}/${c.slug} failed: ${e.message}\n`); return null; }
    }));
    for (const rows of results) {
      if (!rows) continue;
      for (const row of rows) {
        const known = seenSet.has(row.external_id);
        runSeen.push(row.external_id);
        const repost = known && isRepost(seenUpdated[row.external_id], row.updated);
        // Seed a repost baseline for pre-overhaul ids that predate seen_updated (one-time,
        // rolls through the inventory as rows are re-fetched) — without this, reposts of
        // legacy ids are undetectable forever (isRepost(undefined, x) === false).
        if (known && !seenUpdated[row.external_id] && row.updated) seenUpdated[row.external_id] = row.updated;
        if (known && !repost && !noPersist) continue; // incremental dedup (deep scans include seen)
        if (!known || repost) {
          if (row.updated) seenUpdated[row.external_id] = row.updated; // baseline for future repost checks
        }
        if (!row.title || !row.url) continue;
        if (!freshEnough(row.updated, freshDays)) continue; // zombie-posting guard
        if (titleHardExcluded(row.title, titleFilter, row.company)) { droppedTitle++; continue; }
        // Pure-manual QA titles (an explicit "manual" with no automation signal) — same intent
        // as the LinkedIn JD vet, decided on the title alone since we don't fetch ATS JDs.
        if (titleFilter.off_field === 'qa' && /\bmanual\b/i.test(row.title) && !titleSignalsAutomation(row.title)) { droppedTitle++; continue; }
        if (foreignLocation(`${row.title} ${row.location}`)) { // global boards mix regions
          droppedForeign++;
          process.stderr.write(`[ats.mjs] foreign-dropped: ${row.company} | ${row.title} | ${row.location}\n`);
          continue;
        }
        const { keep, location } = evaluateLocation(`${row.title} ${row.company} ${row.location}`, locFilter);
        if (!keep) continue;
        // source is "ats:<platform>" (like telegram:<channel>) so the Sheet's מקור column —
        // and therefore the weekly-review outcome funnel — measures each platform separately.
        candidates.push({
          source: `ats:${row.external_id.split(':')[0]}`,
          ats: row.external_id.split(':')[0],
          title: row.title,
          company: row.company,
          location,
          url: row.url,
          snippet: `${row.title} at ${row.company} — ${row.location} (career page${row.updated ? `, updated ${row.updated.slice(0, 10)}` : ''}${row.experience_level ? `, level: ${row.experience_level}` : ''})`,
          score: 0,
          query: row.external_id.split(':')[1],
          updated: row.updated,
          repost,
        });
      }
    }
  }
  if (droppedTitle) process.stderr.write(`[ats.mjs] dropped ${droppedTitle} junior/management/off-field/manual title(s)\n`);
  if (droppedForeign) process.stderr.write(`[ats.mjs] dropped ${droppedForeign} foreign-located posting(s)\n`);

  // Persist: merge ids; a company that failed this run contributes nothing and simply
  // backfills on its first successful run (the freshness cut keeps that from flooding).
  if (!noPersist) {
    writeJsonAtomic(STATE_PATH, {
      backfilled: true,
      last_run: todayInTz(), // tz-aware (Asia/Jerusalem), not naive UTC
      seen_ids: pruneSeenIds([...(state.seen_ids || []), ...runSeen], SEEN_CAP),
      seen_updated: seenUpdated,
      comeet_tokens: tokenCache,
    }, { pretty: 0 }); // compact (jobscout state format)
  }

  const out = { ok: true, count: candidates.length, candidates, companies: companies.length, failed };
  if (isBackfill) out.backfill = true;
  if (deepDays) { out.deep = true; out.window_days = deepDays; }
  out.persisted = !noPersist;
  console.log(JSON.stringify(out));
}

main().catch((e) => fail(e));
