// Link-quality gate for the job scout — pure classification + liveness verdicts.
// Built 2026-07-16 after a run of bad Sheet links: dead postings (404 / redirect-to-homepage /
// closed), a url column holding page-title TEXT instead of a URL, and junk links (a Glassdoor
// search-results page, a Facebook group post). Everything here is unit-tested in
// lib/verify-links.test.mjs; the pure classifiers need no I/O, and verifyCandidate takes an
// injectable fetchImpl so the liveness path (incl. the fail-open rule) is testable too.
//
// Verdicts per candidate {id?, url, title?, company?}:
//   not-a-url — url missing / not a sane https?://<host>/… → DROP
//   junk      — search/feed/post page, never an application page → DROP
//   dead      — confirmed dead via HTTP GET (404/410, homepage-collapse, dead-marker,
//               closed-posting body text; LinkedIn via checkLinkedInOpen) → DROP
//   ok        — everything else. FAIL-OPEN: network errors / timeouts / 403/429/999 /
//               LinkedIn authwall are ok (reason "unverifiable") — only CONFIRMED death drops.
import { checkLinkedInOpen } from './linkedin.mjs';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENCY = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Pure URL-format checks -------------------------------------------------------------

// Loose scheme check for the sheet.mjs hard-guard: a non-empty url field must start with
// http(s)://. (Empty string is allowed by the caller — some gmail-backfill rows have no URL.)
export function hasHttpScheme(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

// A "sane" job URL: scheme + a dotted host + no whitespace before the path. Page-title TEXT
// ("Senior QA Engineer at Acme"), bare hosts ("www.x.com"), and empty values all fail this.
export function looksLikeUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (/\s/.test(s)) return false; // a real URL has no spaces (title text does)
  return /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(s);
}

// ---- Junk classification ----------------------------------------------------------------

// Search / feed / post pages that are never a single application page. Specific job-detail
// pages on Israeli aggregators (jobhunt.co.il/jobs/<slug>, alljobs, drushim job pages) are
// deliberately NOT flagged here — they return false → fall through to the liveness check.
export function isJunkUrl(url) {
  let u;
  try { u = new URL(String(url || '')); }
  catch { return false; } // malformed → not-a-url handles it, not junk
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname || '/';
  const pathq = path + (u.search || '');

  if (/(^|\.)facebook\.com$/.test(host) || host === 'fb.com') return true;
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return true;
  // Glassdoor listing/search surfaces: SRCH results, /Job/ index, any search path.
  if (/glassdoor\./.test(host) && /SRCH|\/Job\/|\/Search|search/i.test(pathq)) return true;
  // LinkedIn jobs SEARCH results (not a jobs/view/<id> posting).
  if (/(^|\.)linkedin\.com$/.test(host) && /^\/jobs\/search/i.test(path)) return true;
  // Google (any TLD) /search results.
  if (/(^|\.)google\./.test(host) && /^\/search/i.test(path)) return true;
  return false;
}

// Static (no-network) verdict, or null when the URL needs a liveness check.
export function classifyStatic({ url } = {}) {
  if (!looksLikeUrl(url)) return { verdict: 'not-a-url', reason: 'url missing or not a valid http(s) URL' };
  if (isJunkUrl(url)) return { verdict: 'junk', reason: 'search/feed/post page, not an application page' };
  return null;
}

// ---- Dead-detection helpers (pure — operate on a fetch result) --------------------------

// Confirmed-dead HTTP statuses. 403/429/999 are BOT-BLOCKING, not death → handled fail-open.
export function isDeadStatus(status) {
  return status === 404 || status === 410;
}

// Bot-blocking / rate-limit statuses → unverifiable (fail open, keep).
export function isBotBlockStatus(status) {
  return status === 403 || status === 429 || status === 999;
}

// The server bounced us to the site root/homepage — the posting is gone. Only a "collapse"
// when the final path is root AND the original had a deeper path (so a link that was always a
// homepage isn't self-reported as a collapse). drushim bounces dead job pages to /, /jobs.
export function isHomepageCollapse(finalUrl, originalUrl) {
  let f;
  try { f = new URL(String(finalUrl || '')); }
  catch { return false; }
  const fPath = f.pathname || '/';
  const fHost = f.hostname.toLowerCase().replace(/^www\./, '');
  const rootish = fPath === '/' || fPath === '';
  const drushimHome = /(^|\.)drushim\.co\.il$/.test(fHost) && /^\/(jobs\/?)?$/i.test(fPath);
  if (!rootish && !drushimHome) return false;
  if (originalUrl) {
    try {
      const o = new URL(String(originalUrl));
      const oPath = o.pathname || '/';
      if ((oPath === '/' || oPath === '') && !drushimHome) return false; // was always root
    } catch { /* ignore */ }
  }
  return true;
}

// Known dead-markers in the FINAL url: Workable's /oops page, or a not_found=true query.
export function matchesDeadMarker(finalUrl) {
  const s = String(finalUrl || '');
  if (/workable/i.test(s) && /\/oops(\b|\/|$)/i.test(s)) return true;
  if (/[?&]not_found=true\b/i.test(s)) return true;
  return false;
}

// Closed-posting markers in the page body (case-insensitive; Hebrew + English).
const CLOSED_MARKERS = [
  'position has been filled',
  'no longer available',
  'no longer accepting',
  'job not found',
  'job expired',
  'המשרה אוישה',
  'משרה זו אינה',
  'המשרה לא נמצאה',
  'לא נמצאה המשרה',
];
export function bodyIsClosed(html) {
  const s = String(html || '').toLowerCase();
  return CLOSED_MARKERS.some((m) => s.includes(m.toLowerCase()));
}

// A short, human Hebrew reason for the maintenance Sheet note (Part A mode 2).
export function maintenanceReason(verdict) {
  if (verdict === 'dead') return 'הקישור מת (404 / הפניה לדף הבית / משרה סגורה)';
  if (verdict === 'not-a-url') return 'הכתובת אינה קישור תקין';
  if (verdict === 'junk') return 'עמוד חיפוש/פיד, לא מודעת משרה';
  return 'לא ניתן לאמת';
}

// ---- Liveness fetch ----------------------------------------------------------------------

async function defaultFetch(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': BROWSER_UA },
    });
    const body = await r.text();
    return { status: r.status, finalUrl: r.url || url, body };
  } finally { clearTimeout(t); }
}

// One retry on a thrown network error; if the retry also throws, the error propagates
// (caller turns it into a fail-open "unverifiable" verdict).
async function fetchWithRetry(url, fetchImpl) {
  try { return await fetchImpl(url); }
  catch { await sleep(500); return await fetchImpl(url); }
}

// ---- Verdict orchestration ---------------------------------------------------------------

function result(cand, verdict, reason, finalUrl) {
  return { id: cand?.id ?? '', url: cand?.url ?? '', verdict, reason, final_url: finalUrl || '' };
}

// Verify ONE candidate. opts.fetchImpl / opts.linkedinCheck are injectable for testing.
export async function verifyCandidate(cand = {}, opts = {}) {
  const url = cand.url;
  const stat = classifyStatic(cand);
  if (stat) return result(cand, stat.verdict, stat.reason, '');

  // LinkedIn job-view postings use the existing closed-check (fails open on error / authwall).
  if (/linkedin\.com\/jobs\/view\//i.test(url)) {
    const check = opts.linkedinCheck || checkLinkedInOpen;
    const open = await check(url);
    return open
      ? result(cand, 'ok', 'live', url)
      : result(cand, 'dead', 'LinkedIn posting closed', url);
  }

  const fetchImpl = opts.fetchImpl || defaultFetch;
  let res;
  try { res = await fetchWithRetry(url, fetchImpl); }
  catch { return result(cand, 'ok', 'unverifiable', ''); } // network error / timeout → keep

  const { status, finalUrl, body } = res || {};
  if (isBotBlockStatus(status)) return result(cand, 'ok', 'unverifiable', finalUrl); // bot-block
  if (isDeadStatus(status)) return result(cand, 'dead', `HTTP ${status}`, finalUrl);
  if (isHomepageCollapse(finalUrl, url)) return result(cand, 'dead', 'redirected to site homepage', finalUrl);
  if (matchesDeadMarker(finalUrl)) return result(cand, 'dead', 'dead-posting marker in final URL', finalUrl);
  if (bodyIsClosed(body)) return result(cand, 'dead', 'closed-posting text on page', finalUrl);
  return result(cand, 'ok', 'live', finalUrl);
}

// Verify a batch with bounded concurrency (≤5). Preserves input order. opts.politeMs adds a
// small per-request pause (be polite to the boards); tests leave it 0.
export async function verifyBatch(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const concurrency = Math.max(1, Math.min(opts.concurrency || MAX_CONCURRENCY, MAX_CONCURRENCY));
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      results[i] = await verifyCandidate(list[i], opts);
      if (opts.politeMs) await sleep(opts.politeMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  return results;
}
