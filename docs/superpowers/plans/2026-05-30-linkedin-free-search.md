# LinkedIn Free Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free, no-auth LinkedIn job source (`linkedin.mjs`) that backfills all matching center-Israel QA/Automation jobs on first run, then incrementally surfaces only new ones, feeding the existing scout pipeline.

**Architecture:** A new CLI tool `workspace/tools/linkedin.mjs` fetches LinkedIn's public guest jobs endpoint (no account/key/payment), parses job cards, reuses the existing `evaluateLocation` filter, dedups via a `linkedin-seen.json` state ledger (backfill vs adaptive-window incremental modes), drops closed postings, and prints the **same JSON shape as `search.mjs`** so the pipeline consumes it unchanged. Pure helpers live in `lib/linkedin.mjs` (unit-tested); the closed-check is shared with `search.mjs`.

**Tech Stack:** Node 22 (ESM `.mjs`), `node:test` + `node:assert/strict`, `curl` via `node:child_process`. Zero new dependencies.

> **Repo note:** This project is **not** git-initialized (`git rev-parse` → not a repo). Each task ends with a **Checkpoint** (run the test suite) instead of a git commit. If git is later initialized, commit at each checkpoint with the suggested message.

> **Spec:** `docs/superpowers/specs/2026-05-30-linkedin-free-search-design.md`

---

## File Structure

- **Create** `workspace/tools/lib/linkedin.mjs` — pure helpers + shared `checkLinkedInOpen`:
  `buildSearchUrl`, `canonicalJobUrl`, `parseCards`, `incrementalWindowSeconds`,
  `BACKFILL_WINDOW`, `isClosedHtml`, `checkLinkedInOpen`, `filterNewCandidates`, `pruneSeen`.
- **Create** `workspace/tools/lib/linkedin.test.mjs` — unit tests for the pure helpers.
- **Create** `workspace/tools/linkedin.mjs` — orchestration (config/state load, fetch loop, filter, dedup, closed-check, emit JSON, persist state).
- **Modify** `workspace/tools/search.mjs` — remove `LINKEDIN_KEYWORDS` + the appended `site:linkedin.com/jobs` queries; import `checkLinkedInOpen` from the shared lib (delete the local copy).
- **Modify** `workspace/skills/job-scout/sources.json` — remove the `site:linkedin.com` Tavily query; add a `linkedin` block with the keyword list.
- **Modify** `workspace/skills/job-scout/prompt-scout.md` — Step 1: run `linkedin.mjs` and merge its candidates.
- **Modify** `CLAUDE.md` — add `linkedin.mjs` to the tools map + a short note.
- **Runtime (not created by hand)** `workspace/data/linkedin-seen.json` — state ledger, created on first run.

---

## Task 1: Shared lib scaffold — `buildSearchUrl` + `canonicalJobUrl`

**Files:**
- Create: `workspace/tools/lib/linkedin.mjs`
- Test: `workspace/tools/lib/linkedin.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `workspace/tools/lib/linkedin.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, canonicalJobUrl } from './linkedin.mjs';

test('buildSearchUrl encodes keyword, location, window, start', () => {
  const url = buildSearchUrl({ keyword: 'QA Automation', location: 'Israel', tprSeconds: 604800, start: 25 });
  assert.ok(url.startsWith('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?'));
  assert.match(url, /keywords=QA(\+|%20)Automation/);
  assert.match(url, /location=Israel/);
  assert.match(url, /f_TPR=r604800/);
  assert.match(url, /start=25/);
});

test('buildSearchUrl floors fractional seconds', () => {
  const url = buildSearchUrl({ keyword: 'x', location: 'Israel', tprSeconds: 86400.9, start: 0 });
  assert.match(url, /f_TPR=r86400/);
});

test('canonicalJobUrl builds a stable view URL', () => {
  assert.equal(canonicalJobUrl('4418561672'), 'https://www.linkedin.com/jobs/view/4418561672');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: FAIL — `Cannot find module './linkedin.mjs'` / export not found.

- [ ] **Step 3: Write minimal implementation**

Create `workspace/tools/lib/linkedin.mjs`:

```js
// Shared LinkedIn helpers for the job scout.
// Pure functions here are unit-tested in lib/linkedin.test.mjs.
// checkLinkedInOpen does network I/O and is shared with search.mjs.
import { execFile } from 'node:child_process';

const GUEST_ENDPOINT =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const DAY = 86400;             // seconds in a day
export const BACKFILL_WINDOW = 30 * DAY; // 2592000 — backfill + adaptive-window cap

// Build a guest-search URL. tprSeconds -> f_TPR=r<seconds>.
export function buildSearchUrl({ keyword, location, tprSeconds, start }) {
  const qs = new URLSearchParams({
    keywords: keyword,
    location,
    f_TPR: `r${Math.floor(tprSeconds)}`,
    start: String(start),
  });
  return `${GUEST_ENDPOINT}?${qs.toString()}`;
}

// Canonical, dedupe-stable job URL from a posting id.
export function canonicalJobUrl(id) {
  return `https://www.linkedin.com/jobs/view/${id}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: all pass. (Git commit message if/when git exists: `feat(linkedin): add buildSearchUrl + canonicalJobUrl helpers`)

---

## Task 2: `parseCards` — extract jobs from guest HTML

**Files:**
- Modify: `workspace/tools/lib/linkedin.mjs`
- Test: `workspace/tools/lib/linkedin.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `workspace/tools/lib/linkedin.test.mjs`:

```js
import { parseCards } from './linkedin.mjs';

const FIXTURE = `
<ul class="jobs-search__results-list">
<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:4418561672">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/automation-team-lead-at-algosec-4418561672"></a>
    <h3 class="base-search-card__title">
                Automation Team Lead, Israel
            </h3>
    <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://www.linkedin.com/company/algosec">AlgoSec</a>
    </h4>
    <span class="job-search-card__location">
                Petah Tikva, Center District, Israel
            </span>
  </div>
</li>
<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:4418983486">
    <a class="base-card__full-link" href="#"></a>
    <h3 class="base-search-card__title">
                QA Automation Team Leader &amp; SDET
            </h3>
    <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="#">SolarEdge</a>
    </h4>
    <span class="job-search-card__location">
                Ramat Gan, Tel Aviv District, Israel
            </span>
  </div>
</li>
</ul>`;

test('parseCards extracts id/title/company/location and unescapes entities', () => {
  const cards = parseCards(FIXTURE);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    id: '4418561672',
    title: 'Automation Team Lead, Israel',
    company: 'AlgoSec',
    location: 'Petah Tikva, Center District, Israel',
  });
  assert.equal(cards[1].id, '4418983486');
  assert.equal(cards[1].title, 'QA Automation Team Leader & SDET');
  assert.equal(cards[1].company, 'SolarEdge');
  assert.equal(cards[1].location, 'Ramat Gan, Tel Aviv District, Israel');
});

test('parseCards returns [] for empty/garbage input', () => {
  assert.deepEqual(parseCards(''), []);
  assert.deepEqual(parseCards('<html>no jobs here</html>'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: FAIL — `parseCards` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `workspace/tools/lib/linkedin.mjs`:

```js
// Parse the guest-endpoint HTML into job cards.
// Returns [{ id, title, company, location }] for each <li> card with an id + title.
export function parseCards(html) {
  if (!html) return [];
  const blocks = String(html).split(/<li[ >]/i).slice(1); // drop preamble before first <li
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: PASS (all tests so far).

- [ ] **Step 5: Checkpoint**

Run the suite again; all pass. (Commit msg: `feat(linkedin): add parseCards HTML parser`)

---

## Task 3: `incrementalWindowSeconds` — adaptive window

**Files:**
- Modify: `workspace/tools/lib/linkedin.mjs`
- Test: `workspace/tools/lib/linkedin.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `workspace/tools/lib/linkedin.test.mjs`:

```js
import { incrementalWindowSeconds, BACKFILL_WINDOW } from './linkedin.mjs';

test('window = (gap + 1 day) for a normal daily run', () => {
  // last run yesterday -> 2 days
  assert.equal(incrementalWindowSeconds('2026-05-29', '2026-05-30'), 2 * 86400);
});

test('window widens after a multi-day outage', () => {
  // 6 days gap -> 7 days
  assert.equal(incrementalWindowSeconds('2026-05-24', '2026-05-30'), 7 * 86400);
});

test('window is capped at 30 days', () => {
  assert.equal(incrementalWindowSeconds('2026-01-01', '2026-05-30'), BACKFILL_WINDOW);
});

test('same-day run still covers at least 1 day', () => {
  assert.equal(incrementalWindowSeconds('2026-05-30', '2026-05-30'), 1 * 86400);
});

test('missing/invalid last_run falls back to the cap', () => {
  assert.equal(incrementalWindowSeconds(null, '2026-05-30'), BACKFILL_WINDOW);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: FAIL — `incrementalWindowSeconds` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `workspace/tools/lib/linkedin.mjs`:

```js
// Window (seconds) for an incremental run: cover the gap since last_run + 1 day buffer,
// clamped to [1 day, 30 days]. Dates are 'YYYY-MM-DD' strings.
export function incrementalWindowSeconds(lastRun, today) {
  const a = Date.parse(`${lastRun}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return BACKFILL_WINDOW;
  const days = Math.max(0, Math.round((b - a) / (86400 * 1000)));
  const secs = (days + 1) * 86400;
  return Math.min(Math.max(secs, 86400), BACKFILL_WINDOW);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run the suite; all pass. (Commit msg: `feat(linkedin): add adaptive incrementalWindowSeconds`)

---

## Task 4: `isClosedHtml` + shared `checkLinkedInOpen`

**Files:**
- Modify: `workspace/tools/lib/linkedin.mjs`
- Test: `workspace/tools/lib/linkedin.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `workspace/tools/lib/linkedin.test.mjs`:

```js
import { isClosedHtml } from './linkedin.mjs';

test('isClosedHtml detects closed postings (EN + HE)', () => {
  assert.equal(isClosedHtml('<div>No longer accepting applications</div>'), true);
  assert.equal(isClosedHtml('משרה זו אינה מקבלת עוד מועמדים'), true);
  assert.equal(isClosedHtml('we are not accepting applications'), true);
});

test('isClosedHtml returns false for an open posting', () => {
  assert.equal(isClosedHtml('<button>Apply now</button>'), false);
  assert.equal(isClosedHtml(''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: FAIL — `isClosedHtml` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `workspace/tools/lib/linkedin.mjs`:

```js
// True if a fetched LinkedIn job page indicates the posting is closed.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: PASS. (`checkLinkedInOpen` itself is network I/O, exercised in the Task 9 e2e — only `isClosedHtml` is unit-tested.)

- [ ] **Step 5: Checkpoint**

Run the suite; all pass. (Commit msg: `feat(linkedin): add isClosedHtml + shared checkLinkedInOpen`)

---

## Task 5: `filterNewCandidates` + `pruneSeen` — ledger helpers

**Files:**
- Modify: `workspace/tools/lib/linkedin.mjs`
- Test: `workspace/tools/lib/linkedin.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `workspace/tools/lib/linkedin.test.mjs`:

```js
import { filterNewCandidates, pruneSeen } from './linkedin.mjs';

test('filterNewCandidates keeps only unseen ids', () => {
  const cands = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const fresh = filterNewCandidates(cands, ['2']);
  assert.deepEqual(fresh.map((c) => c.id), ['1', '3']);
});

test('filterNewCandidates accepts a Set and skips id-less items', () => {
  const fresh = filterNewCandidates([{ id: '1' }, {}, { id: '9' }], new Set(['9']));
  assert.deepEqual(fresh.map((c) => c.id), ['1']);
});

test('pruneSeen dedupes and keeps the most recent max ids', () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(i));
  const pruned = pruneSeen([...ids, '0', '1'], 5);
  assert.equal(pruned.length, 5);
  assert.deepEqual(pruned, ['7', '8', '9', '10', '11']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `workspace/tools/lib/linkedin.mjs`:

```js
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

// Dedupe ids preserving order; keep the most recent `max` (tail = newest).
export function pruneSeen(ids, max = 5000) {
  const arr = [...new Set((ids || []).map(String))];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run the suite; all pass. (Commit msg: `feat(linkedin): add ledger helpers filterNewCandidates + pruneSeen`)

---

## Task 6: Main tool — `linkedin.mjs` orchestration

**Files:**
- Create: `workspace/tools/linkedin.mjs`
- Reads: `workspace/skills/job-scout/sources.json`, `workspace/skills/job-scout/allowed-locations.json`
- Writes (runtime): `workspace/data/linkedin-seen.json`

- [ ] **Step 1: Write the tool**

Create `workspace/tools/linkedin.mjs`:

```js
#!/usr/bin/env node
// Free LinkedIn job discovery via the public guest endpoint (no auth/key/payment).
// First run = full backfill (30d, deep). Later runs = incremental (adaptive window,
// early-stop, only new jobs). Prints the same JSON shape as search.mjs so the scout
// pipeline consumes it unchanged.
//
// Usage: node linkedin.mjs
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { buildLocationFilter, evaluateLocation } from './lib/location-filter.mjs';
import {
  buildSearchUrl, parseCards, canonicalJobUrl, checkLinkedInOpen,
  incrementalWindowSeconds, pruneSeen, BACKFILL_WINDOW,
} from './lib/linkedin.mjs';

const execFileP = promisify(execFile);

const SOURCES_PATHS = [
  '/home/davidtobol2580/open_claw/workspace/skills/job-scout/sources.json',
  '/home/davidtobol2580/.openclaw/agents/main/skills/job-scout/sources.json',
];
const LOCATIONS_PATHS = [
  '/home/davidtobol2580/open_claw/workspace/skills/job-scout/allowed-locations.json',
  '/home/davidtobol2580/.openclaw/agents/main/skills/job-scout/allowed-locations.json',
];
const STATE_PATH = '/home/davidtobol2580/open_claw/workspace/data/linkedin-seen.json';

const DEFAULT_KEYWORDS = [
  'QA Automation Team Lead', 'QA Team Lead', 'Automation Team Lead',
  'Senior QA Engineer', 'Senior Automation Engineer',
  'QA Automation', 'Automation Engineer', 'SDET', 'Test Automation', 'QA Engineer',
];
const LOCATION = 'Israel';
const BACKFILL_MAX_PAGES = 25;
const INCREMENTAL_MAX_PAGES = 10;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: String(msg) }));
  process.exit(1);
}

function readFirstExisting(paths, label) {
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')); }
      catch (e) { fail(`Failed to parse ${label} config at ${p}: ${e.message}`); }
    }
  }
  fail(`No ${label} config found in: ${paths.join(', ')}`);
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function loadState() {
  if (!existsSync(STATE_PATH)) return { backfilled: false, last_run: null, seen_ids: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { backfilled: !!s.backfilled, last_run: s.last_run || null, seen_ids: s.seen_ids || [] };
  } catch { return { backfilled: false, last_run: null, seen_ids: [] }; }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

async function fetchPage(url) {
  const { stdout } = await execFileP(
    'curl', ['-sL', '--max-time', '15', '-A', BROWSER_UA, url],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

function sleep300() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }

// Closed-check in small batches so a deep backfill doesn't spawn hundreds of curls at once.
async function checkAllOpen(cands, batch = 8) {
  const res = [];
  for (let i = 0; i < cands.length; i += batch) {
    const slice = cands.slice(i, i + batch);
    res.push(...await Promise.all(slice.map((c) => checkLinkedInOpen(c.url))));
  }
  return res;
}

async function main() {
  const sources = readFirstExisting(SOURCES_PATHS, 'sources');
  const locations = readFirstExisting(LOCATIONS_PATHS, 'allowed-locations');
  const locFilter = buildLocationFilter(locations);

  const cfg = sources?.linkedin || {};
  const keywords = (Array.isArray(cfg.keywords) && cfg.keywords.length) ? cfg.keywords : DEFAULT_KEYWORDS;

  const state = loadState();
  const today = todayStr();
  const isBackfill = !state.backfilled;
  const tprSeconds = isBackfill ? BACKFILL_WINDOW : incrementalWindowSeconds(state.last_run || today, today);
  const maxPages = isBackfill ? BACKFILL_MAX_PAGES : INCREMENTAL_MAX_PAGES;

  const seenSet = new Set((state.seen_ids || []).map(String));
  const runSeen = new Set();   // every id seen this run (added to ledger regardless of filtering)
  const candidates = [];       // location-passed, genuinely-new candidates

  for (const keyword of keywords) {
    let start = 0;
    for (let page = 0; page < maxPages; page++) {
      let html;
      try {
        html = await fetchPage(buildSearchUrl({ keyword, location: LOCATION, tprSeconds, start }));
      } catch (e) {
        process.stderr.write(`[linkedin.mjs] fetch failed kw="${keyword}" start=${start}: ${e.message}\n`);
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
        if (known) continue; // processed on a prior run — skip but it's already in the ledger

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
      if (!isBackfill && newThisPage === 0) break; // incremental early-stop
      sleep300();
    }
  }

  // Drop closed postings before returning.
  let kept = candidates;
  if (candidates.length > 0) {
    const open = await checkAllOpen(candidates);
    kept = candidates.filter((_, i) => open[i]);
    const dropped = candidates.length - kept.length;
    if (dropped > 0) process.stderr.write(`[linkedin.mjs] dropped ${dropped} closed posting(s)\n`);
  }

  // Persist state: merge this run's ids into the ledger, prune, flip backfilled.
  saveState({
    backfilled: true,
    last_run: today,
    seen_ids: pruneSeen([...(state.seen_ids || []), ...runSeen]),
  });

  console.log(JSON.stringify({ ok: true, count: kept.length, candidates: kept }));
}

main().catch((e) => fail(e?.message || e));
```

- [ ] **Step 2: First run (backfill) — manual verification**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node linkedin.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok',j.ok,'count',j.count);console.log((j.candidates||[]).slice(0,8).map(c=>c.title+' | '+c.company+' | '+c.location).join('\n'));})"`
Expected: `ok true`, `count > 0`, and the sample shows center-Israel / Tel-Aviv-District / Remote-IL roles only (no Jerusalem / Haifa / Be'er Sheva). Team Lead + Senior + Mid titles appear.

- [ ] **Step 3: Verify state file written**

Run: `cd /home/davidtobol2580/open_claw/workspace && node -e "const s=require('./data/linkedin-seen.json');console.log('backfilled',s.backfilled,'last_run',s.last_run,'seen',s.seen_ids.length)"`
Expected: `backfilled true`, today's date, `seen > 0`.

- [ ] **Step 4: Second run (incremental early-stop) — manual verification**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node linkedin.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok',j.ok,'count',j.count);})"`
Expected: `ok true`, `count` is ~0 (everything already in the ledger) and the run is noticeably faster — proves incremental early-stop + ledger dedup.

- [ ] **Step 5: Verify location filter cuts blocked cities**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node -e "const{buildLocationFilter,evaluateLocation}=await import('./lib/location-filter.mjs');const loc=JSON.parse(require('fs').readFileSync('../skills/job-scout/allowed-locations.json'));const f=buildLocationFilter(loc);for(const t of['X at Y — Petah Tikva, Center District, Israel','X at Y — Haifa, Israel','X at Y — Ramat Gan, Tel Aviv District, Israel','X at Y — Tel Aviv District, Israel']){console.log(evaluateLocation(t,f).keep, t)}" --input-type=module 2>/dev/null || cd /home/davidtobol2580/open_claw/workspace/tools && node --input-type=module -e "import{buildLocationFilter,evaluateLocation}from'./lib/location-filter.mjs';import{readFileSync}from'node:fs';const loc=JSON.parse(readFileSync('../skills/job-scout/allowed-locations.json'));const f=buildLocationFilter(loc);for(const t of ['Petah Tikva, Center District, Israel','Haifa, Israel','Ramat Gan, Tel Aviv District, Israel','Tel Aviv District, Israel'])console.log(evaluateLocation(t,f).keep, t)"`
Expected: `false Petah Tikva...`, `false Haifa...`, `true Ramat Gan...`, `true Tel Aviv District...`.

- [ ] **Step 6: Checkpoint**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: all unit tests pass; manual runs above behaved as expected. (Commit msg: `feat(linkedin): add linkedin.mjs guest-endpoint scout tool`)

---

## Task 7: Refactor `search.mjs` — drop LinkedIn-via-Tavily, share the closed-check

**Files:**
- Modify: `workspace/tools/search.mjs`

- [ ] **Step 1: Import the shared closed-check, delete the local copy**

In `workspace/tools/search.mjs`, add to the imports near the top (after the `location-filter` import on line ~10):

```js
import { checkLinkedInOpen } from './lib/linkedin.mjs';
```

Then DELETE the entire local `checkLinkedInOpen` function (the block starting with the comment `// Check a LinkedIn jobs URL. Returns true if still accepting...` through its closing `}` — lines ~173-193).

- [ ] **Step 2: Remove the LinkedIn-via-Tavily keyword queries**

DELETE the `LINKEDIN_KEYWORDS` constant (lines ~23-27):

```js
const LINKEDIN_KEYWORDS = [
  'Senior Automation Engineer Israel',
  'QA Automation Engineer Israel',
  'Senior QA Automation Israel',
];
```

And DELETE the loop that appends them (lines ~208-211):

```js
  // Append LinkedIn-via-Tavily queries.
  for (const kw of LINKEDIN_KEYWORDS) {
    queries.push({ query: `${kw} site:linkedin.com/jobs`, max: 6 });
  }
```

- [ ] **Step 3: Verify search.mjs still parses and runs**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --check search.mjs && echo "syntax OK"`
Expected: `syntax OK` (no LinkedIn references remain except the import + the trailing validation block, which is now harmless dead code on Tavily results).

- [ ] **Step 4: Confirm no LinkedIn queries are emitted**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && grep -n "site:linkedin\|LINKEDIN_KEYWORDS\|function checkLinkedInOpen" search.mjs || echo "none found (good)"`
Expected: `none found (good)`.

- [ ] **Step 5: Smoke-run search.mjs (Tavily boards still work)**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node search.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('ok',j.ok,'count',j.count); console.log('linkedin urls:',(j.candidates||[]).filter(c=>/linkedin/.test(c.url)).length)})"`
Expected: `ok true`, some `count` from the Israeli boards, and `linkedin urls: 0` (LinkedIn no longer comes from Tavily).

- [ ] **Step 6: Checkpoint**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs && node --check search.mjs && echo OK`
Expected: tests pass + `OK`. (Commit msg: `refactor(search): drop LinkedIn-via-Tavily, share checkLinkedInOpen`)

---

## Task 8: Update `sources.json` — remove site:linkedin query, add linkedin block

**Files:**
- Modify: `workspace/skills/job-scout/sources.json`

- [ ] **Step 1: Remove the Tavily LinkedIn query**

In `workspace/skills/job-scout/sources.json`, DELETE this line from `tavily.queries` (the last entry, currently line 16 — remember to remove the trailing comma on the now-last entry):

```json
      {"query": "SDET Test Automation Engineer Israel site:linkedin.com", "max": 5}
```

- [ ] **Step 2: Add the `linkedin` block**

Add a top-level `linkedin` key (sibling of `tavily`). The full file should become:

```json
{
  "tavily": {
    "queries": [
      {"query": "Senior Automation Engineer Israel site:alljobs.co.il", "max": 8},
      {"query": "Senior QA Automation Israel site:alljobs.co.il", "max": 8},
      {"query": "Senior Automation Engineer Israel site:jobmaster.co.il", "max": 8},
      {"query": "Senior Automation Engineer Israel site:drushim.co.il", "max": 8},
      {"query": "Senior QA Automation Israel site:drushim.co.il", "max": 8},
      {"query": "Senior Automation Engineer Israel site:indeed.com", "max": 5},
      {"query": "Senior Automation Engineer Israel site:glassdoor.com", "max": 5},
      {"query": "Mid level Automation Engineer Israel site:alljobs.co.il", "max": 6},
      {"query": "Mid level QA Automation Israel site:alljobs.co.il", "max": 6},
      {"query": "Mid level Automation Engineer Israel site:jobmaster.co.il", "max": 6},
      {"query": "Automation Engineer Israel site:drushim.co.il", "max": 6},
      {"query": "SDET Israel site:alljobs.co.il", "max": 5}
    ],
    "time_range": "day",
    "search_depth": "basic"
  },
  "linkedin": {
    "location": "Israel",
    "keywords": [
      "QA Automation Team Lead",
      "QA Team Lead",
      "Automation Team Lead",
      "Senior QA Engineer",
      "Senior Automation Engineer",
      "QA Automation",
      "Automation Engineer",
      "SDET",
      "Test Automation",
      "QA Engineer"
    ]
  }
}
```

- [ ] **Step 2b: Honor `linkedin.location` from config (optional consistency)**

If you want the config's `location` to be authoritative, in `workspace/tools/linkedin.mjs` change the `LOCATION` usage so it reads `cfg.location || 'Israel'`. Edit the line `const LOCATION = 'Israel';` to remove it, and where `location: LOCATION` is passed to `buildSearchUrl`, use `location: (cfg.location || 'Israel')`. (Keep the `DEFAULT_KEYWORDS` fallback as-is.)

- [ ] **Step 3: Verify JSON is valid**

Run: `cd /home/davidtobol2580/open_claw/workspace && node -e "const s=require('./skills/job-scout/sources.json');console.log('tavily queries:',s.tavily.queries.length,'| linkedin keywords:',s.linkedin.keywords.length); if(JSON.stringify(s).includes('linkedin.com'))throw new Error('site:linkedin still present');console.log('no site:linkedin query OK')"`
Expected: `tavily queries: 12 | linkedin keywords: 10`, `no site:linkedin query OK`.

- [ ] **Step 4: Verify linkedin.mjs picks up config keywords**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node -e "const s=require('../skills/job-scout/sources.json');console.log(Array.isArray(s.linkedin.keywords)&&s.linkedin.keywords.includes('QA Team Lead')?'config keywords wired OK':'MISSING')"`
Expected: `config keywords wired OK`.

- [ ] **Step 5: Checkpoint**

Run the unit suite + JSON validation above; all pass. (Commit msg: `config(sources): remove site:linkedin query, add linkedin keyword block`)

---

## Task 9: Wire `linkedin.mjs` into the scout pipeline (`prompt-scout.md`)

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md`

- [ ] **Step 1: Add a Step 1a for LinkedIn after Step 1**

In `workspace/skills/job-scout/prompt-scout.md`, immediately AFTER the Step 1 block (after the line ending `... center-Israel allow-list).`) and BEFORE `## Step 1b — Telegram channel fetch`, insert:

```markdown
## Step 1a — LinkedIn (free public guest endpoint)

```bash
cd /home/davidtobol2580/open_claw/workspace/tools && node linkedin.mjs
```
This outputs `{"ok":true,"count":N,"candidates":[{source:"linkedin",title,company,location,url,snippet,score,query}]}` in the **same shape** as Step 1. It pulls jobs straight from LinkedIn's public guest endpoint (no login/API key/payment). **First run = full backfill** (30 days, all matching open jobs); **later runs = incremental** (adaptive window, only new jobs) thanks to its own `data/linkedin-seen.json` ledger. **Merge these candidates into the same list** as the Step 1 Tavily candidates before scoring.

If the output is `{"ok":false,"error":...}` or `count:0`: continue with the other sources (LinkedIn coverage is best-effort; the ledger means a transient block self-heals next run). These URLs are already canonical `linkedin.com/jobs/view/<id>` links and were already closed-checked by the tool — you may skip the Step 1c re-validation for `source:"linkedin"` candidates.
```

- [ ] **Step 2: Note the merge in Step 2**

In `workspace/skills/job-scout/prompt-scout.md`, Step 2's first line about merging already covers Telegram. Confirm the scout treats Step 1 + Step 1a + Step 1b candidates as one list. No code change — verify the wording in Step 1b ("Merge these candidates into the same list as the Step 1 Tavily candidates") and Step 1a are consistent. If Step 2 enumerates sources explicitly anywhere, add `linkedin` to that enumeration. (As written, Step 2 is source-agnostic, so no change needed.)

- [ ] **Step 3: Verify the doc edits**

Run: `cd /home/davidtobol2580/open_claw/workspace/skills/job-scout && grep -n "Step 1a — LinkedIn\|node linkedin.mjs" prompt-scout.md`
Expected: both lines found, the `node linkedin.mjs` line under the new Step 1a.

- [ ] **Step 4: Checkpoint**

Confirm the doc reads top-to-bottom with Step 1 → 1a → 1b → 1c → 2 in order:
Run: `cd /home/davidtobol2580/open_claw/workspace/skills/job-scout && grep -n "^## Step" prompt-scout.md`
Expected: Steps appear in order including `## Step 1a — LinkedIn`. (Commit msg: `docs(scout): add LinkedIn Step 1a to the daily pipeline`)

---

## Task 10: End-to-end verification + update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full unit suite**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/linkedin.test.mjs`
Expected: all tests pass (Tasks 1-5).

- [ ] **Step 2: End-to-end dry pipeline (LinkedIn → location-filtered candidates)**

Run (re-trigger a fresh backfill to see real volume, then confirm incremental):
```bash
cd /home/davidtobol2580/open_claw/workspace/tools
rm -f ../data/linkedin-seen.json
echo "--- backfill ---"; node linkedin.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('count',j.count)})"
echo "--- incremental (should be ~0, fast) ---"; time node linkedin.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('count',j.count)})"
```
Expected: backfill `count` > 0 (real center-Israel jobs); incremental `count` ≈ 0 and visibly faster.

- [ ] **Step 3: Update the tools map in CLAUDE.md**

In `CLAUDE.md`, in the `tools/` tree under "## Layout", add a line after the `search.mjs` entry:

```
    │   ├── linkedin.mjs            # LinkedIn free guest-endpoint search (backfill→incremental, no auth)
```

And in the same tree, under `data/`, add:

```
    │   └── linkedin-seen.json # LinkedIn dedup ledger (backfilled flag + seen job-ids)
```

- [ ] **Step 4: Add an operational note to CLAUDE.md**

In `CLAUDE.md`, append to the "## How to operate the tools (shell)" code block, after the `node tools/search.mjs ...` line:

```bash
node tools/linkedin.mjs                          # LinkedIn jobs (free, no auth); 1st run=backfill, then incremental
# reset for a fresh full backfill: rm workspace/data/linkedin-seen.json
```

- [ ] **Step 5: Final verification**

Run: `cd /home/davidtobol2580/open_claw && grep -n "linkedin.mjs" CLAUDE.md && cd workspace/tools && node --test lib/linkedin.test.mjs && echo "ALL GOOD"`
Expected: CLAUDE.md references present, all tests pass, `ALL GOOD`.

- [ ] **Step 6: Checkpoint**

(Commit msg: `docs: document linkedin.mjs in project map + ops notes`)

---

## Self-Review notes (author)

- **Spec coverage:** new tool (T6), guest endpoint + parse (T1,T2), adaptive window (T3), backfill/incremental + ledger (T6 uses T3/T5), location filter reuse (T6 + verified T6.S5), closed-check shared (T4,T7), keywords incl. Team Lead/Senior/Mid (T8), junior handled by existing Step 2 scorer (documented in spec; no code), drop Tavily-LinkedIn (T7,T8), pipeline merge (T9), docs (T10). All spec sections map to a task.
- **Junior exclusion** is intentionally NOT a code task — it relies on the existing `prompt-scout.md` Step 2 scorer (per the spec's coverage-first decision). The `f_E` opt-in lever is documented, not implemented (YAGNI).
- **Type consistency:** helper names are identical across tasks (`buildSearchUrl`, `parseCards`, `canonicalJobUrl`, `incrementalWindowSeconds`, `BACKFILL_WINDOW`, `isClosedHtml`, `checkLinkedInOpen`, `filterNewCandidates`, `pruneSeen`). Candidate object shape matches `search.mjs` exactly (`source,title,company,location,url,snippet,score,query`).
- **Note:** `filterNewCandidates` is exported/tested (T5) but the main tool inlines the equivalent id-skip during paging (needed for per-page early-stop). It's kept as a tested, reusable helper; harmless if unused by the tool. If you prefer zero dead exports, you may drop it — but the test documents the dedup contract.
