// Shared LinkedIn helpers for the job scout.
// Pure functions here are unit-tested in lib/linkedin.test.mjs.
// checkLinkedInOpen does network I/O and is shared with search.mjs.
import { execFile } from 'node:child_process';

const GUEST_ENDPOINT =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const DAY = 86400;             // seconds in a day
export const BACKFILL_WINDOW = 30 * DAY; // 2592000 — backfill + adaptive-window cap
export const FRESH_WINDOW = 7 * DAY; // 604800 — hard ceiling on how old a surfaced posting may be — David's 'last week' rule

// Build a guest-search URL. tprSeconds -> f_TPR=r<seconds>.
// sortBy=DD (date-descending) is critical: without it the guest endpoint sorts by
// RELEVANCE, so the same heavily-promoted ~10 jobs dominate page 0 and genuinely-new
// postings sit buried past the cap — the incremental run never reaches them. With DD
// the newest postings come first, so the time-windowed sweep actually captures them.
export function buildSearchUrl({ keyword, location, tprSeconds, start }) {
  const qs = new URLSearchParams({
    keywords: keyword,
    location,
    f_TPR: `r${Math.floor(tprSeconds)}`,
    sortBy: 'DD',
    start: String(start),
  });
  return `${GUEST_ENDPOINT}?${qs.toString()}`;
}

// Canonical, dedupe-stable job URL from a posting id.
export function canonicalJobUrl(id) {
  return `https://www.linkedin.com/jobs/view/${id}`;
}

// Parse the guest-endpoint HTML into job cards.
// Returns [{ id, title, company, location }] for each <li> card with an id + title.
export function parseCards(html) {
  if (!html) return [];
  // Lookahead split keeps the `<li` in each block (consumes nothing), robust to any
  // `<li ...>` attributes; slice(1) drops the preamble before the first <li.
  const blocks = String(html).split(/(?=<li[\s>])/i).slice(1);
  const out = [];
  for (const b of blocks) {
    const idM = b.match(/jobPosting:(\d+)/);
    if (!idM) continue;
    const title =
      extractTag(b, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i) ||
      extractTag(b, /job-search-card__title[^>]*>([\s\S]*?)<\/h3>/i);
    if (!title) continue;
    out.push({
      id: idM[1],
      title,
      company: extractTag(b, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i),
      location: extractTag(b, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/i),
    });
  }
  return out;
}

function extractTag(block, re) {
  const m = block.match(re);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

// Window (seconds) for an incremental run: cover the gap since last_run + 1 day buffer,
// clamped to [1 day, 30 days]. Dates are 'YYYY-MM-DD' strings.
export function incrementalWindowSeconds(lastRun, today) {
  const a = Date.parse(`${lastRun}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return BACKFILL_WINDOW;
  const days = Math.max(0, Math.round((b - a) / (DAY * 1000)));
  const secs = (days + 1) * 86400;
  return Math.min(Math.max(secs, 86400), BACKFILL_WINDOW);
}

// Resolve the search window + pagination for one run. Pure → unit-tested.
//   deepDays>0  → explicit ON-DEMAND deep scan (chat "סריקה עמוקה N יום"): an N-day window that
//                 DELIBERATELY bypasses the daily FRESH_WINDOW 7-day cap, with full pagination and
//                 no early-stop — the point is comprehensiveness, not the daily "last week" rule.
//   isBackfill  → first run: BACKFILL_WINDOW (capped by FRESH_WINDOW), full pagination.
//   else        → incremental: adaptive window (capped by FRESH_WINDOW), early-stop pagination.
export function resolveScanWindow({ deepDays = null, isBackfill, lastRun, today, backfillMaxPages, incrementalMaxPages }) {
  if (deepDays != null && deepDays > 0) {
    return { tprSeconds: Math.floor(deepDays * DAY), maxPages: backfillMaxPages, fullSweep: true, deep: true };
  }
  const rawWindow = isBackfill ? BACKFILL_WINDOW : incrementalWindowSeconds(lastRun || today, today);
  return {
    tprSeconds: Math.min(rawWindow, FRESH_WINDOW),
    maxPages: isBackfill ? backfillMaxPages : incrementalMaxPages,
    fullSweep: isBackfill,
    deep: false,
  };
}

// True if a fetched LinkedIn job page indicates the posting is closed.
// These are literal substring probes seen on live LinkedIn pages (verified 2026-05-30);
// if LinkedIn rephrases them this needs updating (fails open → job kept, not lost).
export function isClosedHtml(html) {
  const s = String(html || '');
  return (
    s.includes('No longer accepting') ||
    s.includes('משרה זו אינה מקבלת') ||
    s.includes('not accepting applications')
  );
}

// Check a LinkedIn job URL. Resolves true if still accepting, false if closed.
// Fails OPEN (true) on timeout/network error so we never silently drop a real job.
export function checkLinkedInOpen(url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), 12000);
    execFile(
      'curl',
      ['-sL', '--max-time', '10', '-A', 'Mozilla/5.0 (compatible; job-scout/1.0)', url],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        clearTimeout(timer);
        if (err) return resolve(true);
        resolve(!isClosedHtml(stdout));
      },
    );
  });
}

// Title alone clearly signals an automation/SDET role — no JD lookup needed.
export function titleSignalsAutomation(title) {
  return /(automation|automated|\bsdet\b|verification|validation|test automation|development in test|\brpa\b|בדיקות אוטומ)/i.test(String(title || ''));
}

// Hard-drop a card on its TITLE alone — for roles clearly outside a person's target,
// BEFORE the JD-automation vet (which let false positives like "GTM Engineer" survive: a
// GTM/sales JD mentions "marketing automation", so jdSignalsAutomation kept it).
//
// ⚠️ PERSON-CONFIGURABLE (2026-06-08). The three buckets below are NOT universal — they
// were tuned for David (IC QA/Automation) and would wrongly nuke a different profile (e.g.
// they'd drop EVERY role of a TPM/PM person like the guest: management→her VP/Head titles, and
// off-field→all her non-QA titles). So each bucket is now opt-in via `filter`, built from
// the person's `sources.json` → `linkedin.title_filter`. Absent/empty filter = NO hard
// title exclusion (rely on the location filter + the LLM CV-match in prompt-scout Step 2).
//   filter.junior:true        → drop junior/intern/entry titles.
//   filter.management:true    → drop team-lead/manager/head/director/VP (IC-only people).
//   filter.off_field:"qa"     → drop titles with NO QA/test/automation signal (David's
//                               robust rule: every role he wants carries one; subsumes
//                               GTM/Sales/Data/Frontend/ML without enumerating them).
// "QA Engineer" (in-field but ambiguous) is KEPT here and still goes through the JD vet.
const JUNIOR_TITLE = /\b(junior|jr\.?|intern|internship|student|graduate|entry[- ]level|trainee)\b|ג'וניור|מתמחה|סטודנט/i;
const MGMT_TITLE = /\b(team ?lead|group lead|tech lead|manager|head of|director|\bvp\b|chief)\b|ראש צוות|מנהל/i;
const IN_FIELD_TITLE =
  /(\bqa\b|q\.a\.|quality assurance|quality engineer|\btest\b|\btests\b|tester|testing|\bsdet\b|\bset\b|in test|automation|automated|verification|validation|\brpa\b|בדיקות|אוטומצי|אוטומט|אבטחת איכות)/i;

export function titleHardExcluded(title, filter = {}) {
  const t = String(title || '');
  if (filter.junior && JUNIOR_TITLE.test(t)) return 'junior';
  if (filter.management && MGMT_TITLE.test(t)) return 'management';
  if (filter.off_field === 'qa' && !IN_FIELD_TITLE.test(t)) return 'off-field';
  return '';
}

// The job-description HTML mentions real automation work (tools/frameworks/automation).
// Used to drop pure-manual-QA roles whose TITLE is ambiguous ("QA Engineer", "Tester").
export function jdSignalsAutomation(html) {
  return /\b(automation|automated|selenium|playwright|cypress|appium|sdet|pytest|testng|junit|webdriver|rest[\s-]?assured|robot framework|test automation|api automation)\b|אוטומצי|אוטומטי/i.test(String(html || ''));
}

// Verdict for one fetched job page. Pure → unit-tested.
//   • '' (fetch failed) → keep (fail OPEN — never silently drop a real job on a network blip).
//   • closed posting → drop.
//   • manual-only → drop ONLY when automationVet is on. That check is QA-specific (David): it
//     drops an ambiguous QA title whose JD shows no automation. For a NON-QA person (the guest: TPM,
//     guest: finance) titleSignalsAutomation is always false and their JDs don't mention
//     automation, so applying it would nuke EVERY role — so it's gated off for them.
export function vetVerdict({ title, html, automationVet }) {
  if (html === '') return { keep: true };
  if (isClosedHtml(html)) return { keep: false, why: 'closed' };
  if (automationVet && !titleSignalsAutomation(title) && !jdSignalsAutomation(html)) {
    return { keep: false, why: 'manual-only' };
  }
  return { keep: true };
}

// Fetch a LinkedIn job-view page HTML (for closed-check + automation-check in one GET).
// Resolves '' on timeout/network error so callers can fail OPEN (never silently drop).
export function fetchJobHtml(url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 14000);
    execFile(
      'curl',
      ['-sL', '--max-time', '12', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', url],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => { clearTimeout(timer); resolve(err ? '' : stdout); },
    );
  });
}

// Candidates whose id is NOT in the seen set/array (cross-run dedup).
export function filterNewCandidates(candidates, seenIds) {
  const seen = seenIds instanceof Set ? seenIds : new Set((seenIds || []).map(String));
  const fresh = [];
  for (const c of candidates || []) {
    if (!c || c.id == null) continue;
    if (!seen.has(String(c.id))) fresh.push(c);
  }
  return fresh;
}

// Dedupe ids preserving FIRST-seen order; keep the tail (the `max` most recent).
// Note: a re-seen id keeps its original position (not refreshed to the tail) — fine at
// max=5000, but don't "fix" this into most-recently-seen without reason.
export function pruneSeen(ids, max = 5000) {
  const arr = [...new Set((ids || []).map(String))];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}
