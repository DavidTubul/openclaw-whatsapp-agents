#!/usr/bin/env node
// Job Scout search aggregator.
// Runs OpenClaw (Tavily) web searches for QA/Automation jobs in Israel,
// cleans the untrusted-content markers, filters by location, dedupes,
// validates LinkedIn URLs (drops "No longer accepting"), and prints JSON.
//
// Usage: node search.mjs
import { execFileSync } from 'node:child_process';
import { launcherPath } from '../../shared/lib/paths.mjs';
import { evaluateLocation } from './lib/location-filter.mjs';
import { checkLinkedInOpen, titleHardExcluded, titleSignalsAutomation } from './lib/linkedin.mjs';
import {
  comeetCareersPageUrl, extractComeetToken, endpoints,
  parseComeetHostedUrl, comeetPositionLive,
} from './lib/ats.mjs';
import { personIdFromArgv, failJson as fail, sleepMsSync } from './lib/cli.mjs';
import { loadPersonContext } from './lib/person-config.mjs';

const OPENCLAW = launcherPath; // repo-root launcher, from shared/lib/paths.mjs
const FETCH_TIMEOUT_MS = 15000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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

// Fetch a Comeet company's live positions payload (for liveness checks). Scrape the per-company
// token from its hosted careers page, then hit the real positions API (same technique ats.mjs uses).
// Returns null on any error/missing token so the caller can fail OPEN.
async function fetchComeetPositions({ slug, uid }) {
  const company = { slug, uid };
  const token = extractComeetToken(await fetchText(comeetCareersPageUrl(company)));
  if (!token) return null;
  return fetchJson(endpoints.comeet(company, token));
}

// Remove the EXTERNAL_UNTRUSTED_CONTENT wrapper markers and the
// "Source: ...\n---\n" prefix, returning just the actual inner text.
function cleanText(s) {
  if (s == null) return '';
  let t = String(s);
  // Drop the opening + closing wrapper markers wherever they appear.
  t = t.replace(/<<<\s*EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, '');
  t = t.replace(/<<<\s*END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi, '');
  // Drop a leading "Source: <something>\n---\n" prefix (whitespace tolerant).
  t = t.replace(/^\s*Source:\s*[^\n]*\n\s*---\s*\n?/i, '');
  return t.trim();
}

// Pull a JSON object out of the openclaw output robustly.
function parseOpenclawOutput(raw) {
  const text = String(raw);
  // First try: locate the first '{' and parse from there to the matching end.
  const start = text.indexOf('{');
  if (start !== -1) {
    const candidate = text.slice(start);
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to brace-matched extraction.
    }
    // Brace-match to find a complete JSON object.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(0, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  // Last resort: try the last non-empty line.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep looking
    }
  }
  throw new Error('Could not parse JSON from openclaw output');
}

// Normalize the various possible response shapes into the results array.
function extractResults(parsed) {
  // Documented shape: { result: { results: [...] } }
  if (parsed?.result?.results && Array.isArray(parsed.result.results)) {
    return parsed.result.results;
  }
  // Observed shape: { outputs: [ { result: { results: [...] } } ] }
  if (Array.isArray(parsed?.outputs)) {
    for (const o of parsed.outputs) {
      if (o?.result?.results && Array.isArray(o.result.results)) {
        return o.result.results;
      }
    }
  }
  // Bare shape: { results: [...] }
  if (Array.isArray(parsed?.results)) return parsed.results;
  return [];
}

function runSearch(query, limit) {
  const out = execFileSync(
    OPENCLAW,
    ['infer', 'web', 'search', '--provider', 'tavily', '--query', query, '--limit', String(limit), '--json'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 }
  );
  const parsed = parseOpenclawOutput(out);
  return extractResults(parsed);
}

function normalizeUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  const q = u.indexOf('?');
  if (q !== -1) u = u.slice(0, q);
  const h = u.indexOf('#');
  if (h !== -1) u = u.slice(0, h);
  u = u.replace(/\/+$/, '');
  return u;
}

// Company extraction from title using common separators.
function extractCompany(title) {
  if (!title) return '';
  const seps = [
    { re: /\s+at\s+(.+)/i },
    { re: /\s+@\s+(.+)/ },
    { re: /\s+-\s+(.+)/ },
    { re: /\s+\|\s+(.+)/ },
  ];
  for (const { re } of seps) {
    const m = title.match(re);
    if (m && m[1]) {
      // Take up to the next separator character.
      let c = m[1].split(/\s+[-|@]\s+|\s+at\s+/i)[0].trim();
      // Trim trailing punctuation noise.
      c = c.replace(/[.,;:]+$/, '').trim();
      if (c) return c;
    }
  }
  return '';
}


async function main() {
  const personId = personIdFromArgv();
  const { sources, locFilter } = loadPersonContext(personId, { sources: true, locationFilter: true });

  // Build the query list. The CLI can't pass Tavily's time_range and results carry no date, so we
  // bias the query TEXT toward recent postings (soft signal; the prompt-scout Step 2 recency rule is
  // the hard backstop).
  const timeRange = sources?.tavily?.time_range; // "day" | "week" | undefined
  const recencyHint = timeRange === 'day' ? ' past 24 hours' : timeRange === 'week' ? ' past week' : '';
  const queries = [];
  const configQueries = sources?.tavily?.queries;
  if (Array.isArray(configQueries)) {
    for (const q of configQueries) {
      if (q && q.query) queries.push({ query: String(q.query) + recencyHint, max: Number(q.max) || 5 });
    }
  }
  if (queries.length === 0) fail('No queries to run (sources.tavily.queries empty and no LinkedIn queries).');

  // Same per-person title filter the LinkedIn + direct-ATS sources use (junior/management/off-field)
  // — one criteria source of truth per person, whatever the job's origin. Tavily results reached
  // scoring with NO hard title pre-filter before this (a pure DevOps title slipped through to David).
  const titleFilter = sources?.linkedin?.title_filter || {};

  const seen = new Set();
  let candidates = [];
  let droppedTitle = 0;

  for (let i = 0; i < queries.length; i++) {
    const { query, max } = queries[i];
    let results;
    try {
      results = runSearch(query, max);
    } catch (e) {
      process.stderr.write(`[search.mjs] query failed, skipping: "${query}" -> ${e.message}\n`);
      continue;
    }

    for (const r of results) {
      const title = cleanText(r?.title);
      const snippet = cleanText(r?.snippet);
      const url = r?.url ? String(r.url) : '';
      const score = typeof r?.score === 'number' ? r.score : 0;

      if (!url) continue;
      const norm = normalizeUrl(url);
      if (!norm || seen.has(norm)) continue;

      const combined = `${title} ${snippet}`;
      const { keep, location } = evaluateLocation(combined, locFilter);
      if (!keep) continue;

      const company = extractCompany(title);
      // Hard title pre-filter, mirroring tools/ats.mjs exactly so behavior is consistent across
      // all three sources: junior/management/off-field, then pure-manual-QA (explicit "manual"
      // with no automation signal) when off_field is qa.
      if (titleHardExcluded(title, titleFilter, company)) { droppedTitle++; continue; }
      if (titleFilter.off_field === 'qa' && /\bmanual\b/i.test(title) && !titleSignalsAutomation(title)) { droppedTitle++; continue; }

      seen.add(norm);
      candidates.push({
        source: 'tavily',
        title,
        company,
        location,
        url,
        snippet,
        score,
        query,
      });
    }

    // Small delay between queries (sequential) to avoid rate limits.
    if (i < queries.length - 1) sleepMsSync(300);
  }
  if (droppedTitle) process.stderr.write(`[search.mjs] dropped ${droppedTitle} junior/management/off-field/manual title(s)\n`);

  // Validate LinkedIn URLs — drop closed postings before returning. Batched (8 at a time,
  // like linkedin.mjs vetAll) so a big result set never fires hundreds of parallel curls.
  const linkedinIdxs = candidates
    .map((c, i) => ({ i, url: c.url }))
    .filter(({ url }) => /linkedin\.com\/jobs\/view\/\d+/i.test(url));

  if (linkedinIdxs.length > 0) {
    const BATCH = 8;
    const checks = [];
    for (let b = 0; b < linkedinIdxs.length; b += BATCH) {
      const slice = linkedinIdxs.slice(b, b + BATCH);
      checks.push(...await Promise.all(slice.map(({ url }) => checkLinkedInOpen(url))));
    }
    const closedUrls = new Set(
      linkedinIdxs.filter((_, ci) => !checks[ci]).map(({ url }) => url),
    );
    if (closedUrls.size > 0) {
      process.stderr.write(
        `[search.mjs] dropped ${closedUrls.size} closed LinkedIn posting(s): ${[...closedUrls].join(', ')}\n`,
      );
    }
    const before = candidates.length;
    candidates = candidates.filter((c) => !closedUrls.has(c.url));
    if (candidates.length < before) {
      process.stderr.write(`[search.mjs] ${before - candidates.length} LinkedIn job(s) removed (no longer accepting)\n`);
    }
  }

  // Validate Comeet-hosted URLs — same intent as the LinkedIn check, but Comeet's job page is a
  // client-side SPA whose raw HTML is the same "no positions" template for open AND closed roles,
  // so a text-match won't work: we hit Comeet's real positions API and check the position uid is
  // still listed. Group by company (slug+uid) so each company's token + positions list is fetched
  // ONCE per run (cached in a Map). Fails OPEN on any network/parse error, like checkLinkedInOpen.
  // NOTE: the other Tavily ATS platforms (greenhouse/lever/ashby/workable/smartrecruiters/workday)
  // have no liveness check yet — a future pass can extend this using each one's public JSON API
  // (see the `endpoints` object in tools/lib/ats.mjs for the URL shapes already worked out).
  const comeetIdxs = candidates
    .map((c) => ({ url: c.url, parsed: parseComeetHostedUrl(c.url) }))
    .filter((x) => x.parsed);

  if (comeetIdxs.length > 0) {
    const positionsByCompany = new Map(); // "slug/uid" -> positions payload | null (null = fetch failed → fail-open)
    const closedUrls = new Set();
    for (const { url, parsed } of comeetIdxs) {
      const key = `${parsed.slug}/${parsed.uid}`;
      if (!positionsByCompany.has(key)) {
        let positions = null;
        try { positions = await fetchComeetPositions(parsed); } catch { positions = null; }
        positionsByCompany.set(key, positions);
      }
      const positions = positionsByCompany.get(key);
      // Fail open: only drop when we actually got a positions list AND the uid is gone from it.
      if (positions != null && !comeetPositionLive(positions, parsed.positionUid)) closedUrls.add(url);
    }
    if (closedUrls.size > 0) {
      process.stderr.write(
        `[search.mjs] dropped ${closedUrls.size} closed Comeet posting(s): ${[...closedUrls].join(', ')}\n`,
      );
      candidates = candidates.filter((c) => !closedUrls.has(c.url));
    }
  }

  console.log(JSON.stringify({ ok: true, count: candidates.length, candidates }));
}

main().catch((e) => fail(e));
