#!/usr/bin/env node
// Job Scout search aggregator.
// Runs OpenClaw (Tavily) web searches for QA/Automation jobs in Israel,
// cleans the untrusted-content markers, filters by location, dedupes,
// validates LinkedIn URLs (drops "No longer accepting"), and prints JSON.
//
// Usage: node search.mjs
import { execFileSync } from 'node:child_process';
import { evaluateLocation } from './lib/location-filter.mjs';
import { checkLinkedInOpen } from './lib/linkedin.mjs';
import { personIdFromArgv, failJson as fail, sleepMsSync } from './lib/cli.mjs';
import { loadPersonContext } from './lib/person-config.mjs';

const OPENCLAW = '/home/davidtobol2580/open_claw/openclaw';

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

  const seen = new Set();
  const candidates = [];

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

      seen.add(norm);
      candidates.push({
        source: 'tavily',
        title,
        company: extractCompany(title),
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

  // Validate LinkedIn URLs in parallel — drop closed postings before returning.
  const linkedinIdxs = candidates
    .map((c, i) => ({ i, url: c.url }))
    .filter(({ url }) => /linkedin\.com\/jobs\/view\/\d+/i.test(url));

  if (linkedinIdxs.length > 0) {
    const checks = await Promise.all(linkedinIdxs.map(({ url }) => checkLinkedInOpen(url)));
    const closedUrls = new Set(
      linkedinIdxs.filter((_, ci) => !checks[ci]).map(({ url }) => url),
    );
    if (closedUrls.size > 0) {
      process.stderr.write(
        `[search.mjs] dropped ${closedUrls.size} closed LinkedIn posting(s): ${[...closedUrls].join(', ')}\n`,
      );
    }
    const before = candidates.length;
    candidates.splice(0, candidates.length, ...candidates.filter((c) => !closedUrls.has(c.url)));
    if (candidates.length < before) {
      process.stderr.write(`[search.mjs] ${before - candidates.length} LinkedIn job(s) removed (no longer accepting)\n`);
    }
  }

  console.log(JSON.stringify({ ok: true, count: candidates.length, candidates }));
}

main().catch((e) => fail(e));
