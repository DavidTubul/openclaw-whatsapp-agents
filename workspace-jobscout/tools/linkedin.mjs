#!/usr/bin/env node
// Free LinkedIn job discovery via the public guest endpoint (no auth/key/payment).
// First run = full backfill (30d, deep). Later runs = incremental (adaptive window,
// early-stop, only new jobs). Prints the same JSON shape as search.mjs so the scout
// pipeline consumes it unchanged.
//
// Usage: node linkedin.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluateLocation } from './lib/location-filter.mjs';
import {
  buildSearchUrl, parseCards, canonicalJobUrl,
  fetchJobHtml, titleHardExcluded, pruneSeen, resolveScanWindow, vetVerdict,
} from './lib/linkedin.mjs';
import { personIdFromArgv, failJson as fail, sleepMsSync, readJsonSafe, writeJsonAtomic, withRetry } from './lib/cli.mjs';
import { loadPersonContext } from './lib/person-config.mjs';

const execFileP = promisify(execFile);

const SEEN_CAP = 10000; // max job-ids kept in the ledger (a deep backfill can exceed 5k)
const BACKFILL_MAX_PAGES = 25;
const INCREMENTAL_MAX_PAGES = 10;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function todayStr() { return new Date().toISOString().slice(0, 10); }

// `--window-days N` → N or null (a finite positive number only).
function numFlag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function loadState(statePath) {
  const s = readJsonSafe(statePath, {}) || {};
  return { backfilled: !!s.backfilled, last_run: s.last_run || null, seen_ids: s.seen_ids || [] };
}

const saveState = (statePath, state) => writeJsonAtomic(statePath, state);

// One transient curl failure (timeout / network blip) shouldn't abort a keyword's whole sweep,
// so retry once with backoff before giving up; a persistent failure still bubbles to the caller.
async function fetchPage(url) {
  const { stdout } = await withRetry(
    () => execFileP('curl', ['-sL', '--max-time', '15', '-A', BROWSER_UA, url],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
    { tries: 2, baseMs: 400, label: 'linkedin-fetch' },
  );
  return stdout;
}

// Vet candidates in small batches (one GET each, not hundreds at once). For each, the
// single job-page fetch decides BOTH: (a) still open? (b) for an ambiguous QA title, does
// the JD actually mention automation? — so pure-manual-QA roles are dropped. Fails OPEN
// (keep) on fetch error, so we never silently drop a real job over a network blip.
async function vetAll(cands, { automationVet = false, batch = 8 } = {}) {
  const verdicts = [];
  for (let i = 0; i < cands.length; i += batch) {
    const slice = cands.slice(i, i + batch);
    verdicts.push(...await Promise.all(slice.map(async (c) => {
      const html = await fetchJobHtml(c.url);
      return vetVerdict({ title: c.title, html, automationVet });
    })));
  }
  return verdicts;
}

async function main() {
  const personId = personIdFromArgv();
  const { person, sources, locFilter } = loadPersonContext(personId, { sources: true, locationFilter: true });

  const cfg = sources?.linkedin || {};
  const keywords = Array.isArray(cfg.keywords) ? cfg.keywords : [];
  const searchLocation = cfg.location || 'Israel';
  // Per-person title hard-filter (junior/management/off-field). Absent → no hard title
  // exclusion (correct for non-QA people like the guest; David opts into the full QA filter).
  const titleFilter = cfg.title_filter || {};
  // The QA manual-only JD vet is David-specific; gate it on the same opt-in signal so it never
  // nukes a non-QA person's roles (the guest/guest).
  const automationVet = titleFilter.off_field === 'qa';
  // No LinkedIn keywords for this person (e.g. a guest) → skip LinkedIn entirely.
  if (keywords.length === 0) { console.log(JSON.stringify({ ok: true, count: 0, candidates: [] })); return; }

  // On-demand DEEP scan flags (used by chat self-extension for "סריקה עמוקה N יום"):
  //   --window-days N : last N days — bypasses the daily FRESH_WINDOW 7d cap + full pagination.
  //   --no-persist    : read-only — don't write the seen-ledger AND don't hide already-seen jobs,
  //                     so the scan is COMPREHENSIVE + repeatable (the report layer dedups).
  const deepDays = numFlag('--window-days');
  const noPersist = process.argv.includes('--no-persist');

  const STATE_PATH = person.paths.linkedinSeen;
  const state = loadState(STATE_PATH);
  const today = todayStr();
  const isBackfill = !state.backfilled;
  const { tprSeconds, maxPages, fullSweep } = resolveScanWindow({
    deepDays, isBackfill, lastRun: state.last_run, today,
    backfillMaxPages: BACKFILL_MAX_PAGES, incrementalMaxPages: INCREMENTAL_MAX_PAGES,
  });

  const seenSet = new Set((state.seen_ids || []).map(String));
  const runSeen = new Set();   // every id seen this run (added to ledger regardless of filtering)
  const candidates = [];       // location-passed, genuinely-new candidates
  let droppedOffField = 0;     // titles hard-dropped (off-field / junior / management)
  // A backfill only counts as complete if NO fetch error cut a keyword's sweep short.
  // Otherwise we must NOT flip `backfilled` true, or the next run goes incremental and
  // permanently misses the un-fetched jobs (defeats the whole point of backfill).
  let fetchFailed = false;

  for (const keyword of keywords) {
    let start = 0;
    let emptyPages = 0; // consecutive incremental pages with 0 new ids → stop after 2
    for (let page = 0; page < maxPages; page++) {
      let html;
      try {
        html = await fetchPage(buildSearchUrl({ keyword, location: searchLocation, tprSeconds, start }));
      } catch (e) {
        process.stderr.write(`[linkedin.mjs] fetch failed kw="${keyword}" start=${start}: ${e.message}\n`);
        fetchFailed = true;
        break;
      }
      const cards = parseCards(html);
      if (cards.length === 0) break;

      let newThisPage = 0;
      for (const card of cards) {
        if (runSeen.has(card.id)) continue;
        runSeen.add(card.id);
        const known = seenSet.has(card.id);
        if (!known) newThisPage++;
        // Normally skip already-seen jobs (cross-run incremental dedup). But a --no-persist deep
        // scan must be COMPREHENSIVE: include already-seen jobs too (the report layer marks which
        // were sent before), so don't skip them.
        if (known && !noPersist) continue;

        // Hard-drop clearly off-field / junior / management titles up front (e.g. "GTM
        // Engineer", "Sales Engineer", junior roles) — before the JD vet, which would
        // otherwise keep them when their JD happens to mention "automation". id stays in
        // runSeen so it's never re-checked.
        if (titleHardExcluded(card.title, titleFilter)) { droppedOffField++; continue; }

        const { keep, location } = evaluateLocation(`${card.title} ${card.company} ${card.location}`, locFilter);
        if (!keep) continue; // dropped by location; id stays in runSeen so we never re-check it

        candidates.push({
          source: 'linkedin',
          title: card.title,
          company: card.company,
          location,
          url: canonicalJobUrl(card.id),
          snippet: `${card.title} at ${card.company} — ${card.location} (LinkedIn)`,
          score: 0,
          query: keyword,
        });
      }

      start += cards.length;
      // Incremental early-stop: with sortBy=DD the newest jobs come first, so an all-seen
      // page means we've reached already-processed history. Require TWO consecutive
      // all-seen pages before stopping, so one stale/cached page can't cut the sweep short.
      if (!fullSweep) {
        emptyPages = newThisPage === 0 ? emptyPages + 1 : 0;
        if (emptyPages >= 2) break;
      }
      sleepMsSync(300);
    }
  }

  // Drop closed postings AND pure-manual-QA roles (ambiguous title + no automation in JD).
  let kept = candidates;
  if (candidates.length > 0) {
    const verdicts = await vetAll(candidates, { automationVet });
    kept = candidates.filter((_, i) => verdicts[i].keep);
    const closed = verdicts.filter((v) => v.why === 'closed').length;
    const manual = verdicts.filter((v) => v.why === 'manual-only').length;
    if (closed || manual) process.stderr.write(`[linkedin.mjs] dropped ${closed} closed + ${manual} manual-only posting(s)\n`);
  }
  if (droppedOffField) process.stderr.write(`[linkedin.mjs] dropped ${droppedOffField} off-field/junior/management title(s)\n`);

  // Persist state: merge this run's ids into the ledger, prune. Only flip `backfilled`
  // true if it was already true OR this backfill finished with no fetch error (C1) —
  // a partially-fetched first run must re-run as a backfill, not silently go incremental.
  // SKIP entirely on --no-persist (an on-demand deep scan must not touch the daily incremental
  // state — otherwise it would mark every job "seen" and starve the next daily scout).
  if (!noPersist) {
    saveState(STATE_PATH, {
      backfilled: state.backfilled || !fetchFailed,
      last_run: today,
      seen_ids: pruneSeen([...(state.seen_ids || []), ...runSeen], SEEN_CAP),
    });
  }

  const out = { ok: true, count: kept.length, candidates: kept };
  if (deepDays) { out.deep = true; out.window_days = deepDays; }
  out.persisted = !noPersist;
  console.log(JSON.stringify(out));
}

main().catch((e) => fail(e));
