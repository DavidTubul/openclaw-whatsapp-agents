# Job-Scout ("Scotty") Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relax David's seniority/score filters, resurface genuine reposts, add 5 new job sources + wider Tavily dorks, run a one-time full backfill, add a daily interactive QA-interview question, and audit David's CV for ATS compatibility.

**Architecture:** All changes live in `/home/davidtobol2580/open_claw/workspace-jobscout/` (NOT git-tracked — safety comes from `tools/self-edit.mjs snapshot/verify/revert`, not git). Deterministic filters live in `tools/lib/*.mjs` (unit-tested pure functions), LLM policy lives in `skills/job-scout/prompt-scout-person.md`, per-person config in `people/david/*.json`. Policy changes are David-only; guests keep current behavior via config defaults.

**Tech Stack:** Node ESM (`.mjs`), `node --test` unit tests, OpenClaw CLI (`~/open_claw/openclaw`), Tavily via `openclaw infer web search`.

## Global Constraints

- **NEVER run the full scout in testing** — it sends WhatsApp. Tool-level tests use `--no-persist` only. The Task-8 backfill is the one deliberate LIVE run.
- Workspace files are NOT in git. Before the first code edit run `node tools/self-edit.mjs snapshot` (Task 0); after each task run the test suite; after ALL code tasks run `node tools/self-edit.mjs verify`. On unrecoverable breakage: `node tools/self-edit.mjs revert <id>`.
- All policy relaxation applies to person `david` ONLY. Guests (`yossi`, `yuval`, `uri`) must behave byte-identically (their configs lack the new keys → defaults preserve old behavior).
- Sub-agent prompts end with exactly `NO_REPLY` (leak guard). WhatsApp copy is Hebrew.
- Tests: run from `~/open_claw/workspace-jobscout/tools/` with `node --test <file>` (suite: `node --test 'lib/*.test.mjs' '*.test.mjs'` — mirror what `self-edit.mjs verify` runs).
- All `~` below = `/home/davidtobol2580`.

---

### Task 0: Safety snapshot

**Files:** none created by you; snapshot covers files edited in Tasks 1–6, 8–9.

- [ ] **Step 1: Take the snapshot**

```bash
cd ~/open_claw/workspace-jobscout && node tools/self-edit.mjs snapshot '["tools/lib/linkedin.mjs","tools/lib/linkedin.test.mjs","tools/lib/ats.mjs","tools/lib/ats.test.mjs","tools/ats.mjs","tools/ledger.mjs","tools/ledger.test.mjs","tools/linkedin.mjs","tools/search.mjs","people/david/sources.json","people/david/company-watchlist.json","skills/job-scout/prompt-scout-person.md","skills/job-scout/SKILL.md","skills/job-scout/prompt-weekly-review.md","skills/job-scout/prompt-qa.md","skills/job-scout/prompt-backfill-david.md","skills/job-scout/prompt-daily-question.md"]'
```

Expected: JSON with a snapshot `id` (e.g. `20260715-...`). **Record the id** — it is the rollback handle for the whole overhaul. Files that don't exist yet (the two new prompts) are recorded as absent so revert deletes them.

- [ ] **Step 2: Baseline test run**

```bash
cd ~/open_claw/workspace-jobscout/tools && node --test 'lib/*.test.mjs' '*.test.mjs' 2>&1 | tail -5
```

Expected: all tests pass. If not, STOP and report — do not build on a broken baseline.

---

### Task 1: Seniority hard-filter relaxation (deterministic layer)

**Files:**
- Modify: `~/open_claw/workspace-jobscout/tools/lib/linkedin.mjs:192-203` (`titleHardExcluded`)
- Modify: `~/open_claw/workspace-jobscout/tools/ats.mjs:115` (missing `company` arg)
- Modify: `~/open_claw/workspace-jobscout/people/david/sources.json` (`title_filter`)
- Test: `~/open_claw/workspace-jobscout/tools/lib/linkedin.test.mjs`

**Interfaces:**
- Produces: `titleHardExcluded(title, filter, company)` — NEW filter key `internships: true` drops intern/student/trainee independently of `junior`. Returns `'internship'` for those (was `'junior'`). `filter.junior:true` behavior unchanged (drops interns too, exemption list still honored) so guests are unaffected.

- [ ] **Step 1: Write failing tests** — append to `tools/lib/linkedin.test.mjs` (follow the file's existing `test(...)` style):

```js
test('titleHardExcluded: internships flag drops interns but passes junior/mid/unspecified', () => {
  const f = { internships: true, management: true, off_field: 'qa' }; // David's new filter
  assert.equal(titleHardExcluded('QA Automation Intern', f, 'SomeStartup'), 'internship');
  assert.equal(titleHardExcluded('סטודנט לבדיקות תוכנה', f, 'SomeStartup'), 'internship');
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', f, 'SomeStartup'), '');
  assert.equal(titleHardExcluded('QA Automation Engineer', f, 'SomeStartup'), '');
  assert.equal(titleHardExcluded('QA Team Lead', f, 'SomeStartup'), 'management');
});

test('titleHardExcluded: legacy junior:true still drops interns (guests unchanged)', () => {
  const f = { junior: true };
  assert.equal(titleHardExcluded('Software Intern', f, 'Anywhere'), 'internship');
  assert.equal(titleHardExcluded('Junior Analyst', f, 'Anywhere'), 'junior');
});
```

Note: if an existing test asserts the intern case returns `'junior'`, update that assertion to `'internship'` — the reason string is changing deliberately (better drops.jsonl observability).

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd ~/open_claw/workspace-jobscout/tools && node --test lib/linkedin.test.mjs 2>&1 | tail -5
```
Expected: FAIL (new tests; `'internship'` not returned).

- [ ] **Step 3: Implement** — in `tools/lib/linkedin.mjs`, replace the body of `titleHardExcluded` (lines 192-203) with:

```js
export function titleHardExcluded(title, filter = {}, company = '') {
  const t = String(title || '');
  // Internships/student/trainee are dropped whenever EITHER flag is on: David (2026-07-15)
  // keeps internships:true with junior:false — junior/mid/unspecified now pass everywhere,
  // internships never do. Legacy junior:true (guests) implies the intern drop, as before.
  if ((filter.internships || filter.junior) && INTERN_TITLE.test(t)) return 'internship';
  if (filter.junior && JUNIOR_TITLE.test(t) && !companyIsJuniorExempt(company, filter.junior_exempt_big_companies)) {
    return 'junior';
  }
  if (filter.management && MGMT_TITLE.test(t)) return 'management';
  if (filter.off_field === 'qa' && !IN_FIELD_TITLE.test(t)) return 'off-field';
  return '';
}
```

Also update the doc-comment block above the regexes (lines 156-168): replace the `filter.junior:true` bullet with the new two-flag semantics (junior → junior drop w/ exemption list; internships → intern drop only; David = `{internships:true, management:true, off_field:"qa"}` as of 2026-07-15).

- [ ] **Step 4: Fix the ATS call-site bug** — `tools/ats.mjs` line 115, add the company arg:

```js
        if (titleHardExcluded(row.title, titleFilter, row.company)) { droppedTitle++; continue; }
```

- [ ] **Step 5: Update David's config** — in `people/david/sources.json`, replace the `title_filter` opening keys (keep `junior_exempt_big_companies` — harmless, now unused for david; guests never had it):

```json
    "title_filter": {
      "junior": false,
      "internships": true,
      "management": true,
      "off_field": "qa",
      "_policy_comment": "2026-07-15, per David: junior/mid/unspecified pass from ANY company (junior:false). Internships/student/trainee always dropped (internships:true). The junior_exempt_big_companies list below is retired (kept for history).",
```

(The `_junior_exempt_comment` and the list stay in place below these keys.)

- [ ] **Step 6: Run tests, verify pass**

```bash
cd ~/open_claw/workspace-jobscout/tools && node --test lib/linkedin.test.mjs 2>&1 | tail -5
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('/home/davidtobol2580/open_claw/workspace-jobscout/people/david/sources.json','utf8')).linkedin.title_filter.junior))"
```
Expected: tests PASS; second command prints `false`.

---

### Task 2: Score threshold 50 + per-person scoring config (LLM layer)

**Files:**
- Modify: `~/open_claw/workspace-jobscout/people/david/sources.json` (new `scoring` block)
- Modify: `~/open_claw/workspace-jobscout/skills/job-scout/prompt-scout-person.md` (Step 2 + Step 6)

**Interfaces:**
- Produces: `sources.json` top-level `"scoring": {"min_score": 50, "levels_acceptable": ["senior","mid","junior","unknown"]}`. Prompt reads it; absent block → legacy defaults (70, senior+mid) so guests are untouched.

- [ ] **Step 1: Add the scoring block** to `people/david/sources.json` as a new top-level key (sibling of `"tavily"`/`"linkedin"`):

```json
  "scoring": {
    "_comment": "2026-07-15: David's KEEP policy. levels_acceptable covers ALL levels except internships; min_score is the fallback keep for odd cases. Guests have no scoring block -> prompt defaults (min_score 70, levels senior+mid).",
    "min_score": 50,
    "levels_acceptable": ["senior", "mid", "junior", "unknown"]
  },
```

- [ ] **Step 2: Rewrite the KEEP rule** in `prompt-scout-person.md`. Replace lines 122-123 (the `KEEP a candidate only if...` line AND the whole `**Junior exception (David, 2026-07-13...)**` paragraph) with:

```markdown
**KEEP rule (per-person, from `P`'s `sources.json` → `scoring`):** read `scoring.min_score` and `scoring.levels_acceptable` from the `sources.json` you can `cat` at `~/open_claw/workspace-jobscout/people/<P.id>/sources.json`. KEEP a candidate if `level ∈ scoring.levels_acceptable` OR `score >= scoring.min_score`. If the person has NO `scoring` block, use the legacy defaults: `levels_acceptable = [senior, mid]`, `min_score = 70`. Drop the rest.
**David (2026-07-15 policy):** his block is `min_score: 50`, `levels_acceptable: [senior, mid, junior, unknown]` — i.e. every seniority level from ANY company passes; there is no big-company condition anymore. Internships/student/trainee are ALWAYS dropped regardless of config (they are hard-filtered upstream too).
```

- [ ] **Step 3: Sync the two stale references to the old policy** in the same file:
  - Line 112 `calibrate so ~70+ = ...` → append: `The KEEP cutoff itself comes from P's scoring config (see KEEP rule) — do not hardcode 70.`
  - Line 117 strong-negative bullet: change `junior/intern/entry (for David: junior at a large/well-known company is OK — see the junior exception below the KEEP rule; intern never is)` to `intern/student/trainee (always a drop); junior only if junior ∉ P's levels_acceptable`.

- [ ] **Step 4: Show seniority in the report** — in BOTH Step-6 templates (owner line-items block at ~line 289-293 and guest block at ~line 317-321), change the company line from:

```
   🏢 {company} · 📍 {location}
```
to:
```
   🏢 {company} · 📍 {location} · 🎚️ {level}
```

- [ ] **Step 5: Verify JSON parses + prompt consistency**

```bash
node -e "const s=JSON.parse(require('fs').readFileSync('/home/davidtobol2580/open_claw/workspace-jobscout/people/david/sources.json','utf8')); console.log(s.scoring.min_score, s.scoring.levels_acceptable.join(','))"
grep -n "junior exception\|score >= 70\|senior, mid}" ~/open_claw/workspace-jobscout/skills/job-scout/prompt-scout-person.md
```
Expected: `50 senior,mid,junior,unknown`; grep finds NO leftovers of the old rule (empty output).

---

### Task 3: Repost resurfacing (ledger upsert + ATS repost detection + LinkedIn datePosted + prompt)

**Files:**
- Modify: `~/open_claw/workspace-jobscout/tools/ledger.mjs` (`addToLedger` upsert)
- Modify: `~/open_claw/workspace-jobscout/tools/lib/ats.mjs` (new pure `isRepost`)
- Modify: `~/open_claw/workspace-jobscout/tools/ats.mjs` (repost pass-through + `seen_updated` state)
- Modify: `~/open_claw/workspace-jobscout/tools/lib/linkedin.mjs` (new `extractDatePosted`)
- Modify: `~/open_claw/workspace-jobscout/tools/linkedin.mjs` (attach `posted` to candidates during vet)
- Modify: `~/open_claw/workspace-jobscout/skills/job-scout/prompt-scout-person.md` (Step 3a + Step 6 + stale-rule carve-out)
- Test: `tools/ledger.test.mjs`, `tools/lib/ats.test.mjs`, `tools/lib/linkedin.test.mjs`

**Interfaces:**
- Produces: `isRepost(prevUpdated, curUpdated, minDays=21)` → bool (lib/ats.mjs). ATS candidates may carry `repost: true` + `updated`. LinkedIn candidates may carry `posted` (`YYYY-MM-DD` or `''`). Ledger `add` upserts: existing id → refresh `date`/`url`/`title`, preserve `first_date`. `check` output unchanged.
- Consumes: `titleHardExcluded` from Task 1.

- [ ] **Step 1: Failing tests.** Append to `tools/ledger.test.mjs`:

```js
test('addToLedger upserts existing id: refreshes date, preserves first_date', () => {
  const file = mkTmpLedger(); // follow the file's existing tmp-file helper pattern; create one if absent
  addToLedger(file, [{ company: 'Wix', role: 'QA Automation Engineer', url: 'u1', title: 'QA Automation Engineer', date: '2026-06-01' }]);
  addToLedger(file, [{ company: 'Wix', role: 'QA Automation Engineer', url: 'u2', title: 'QA Automation Engineer', date: '2026-07-15' }]);
  const led = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(led.sent.length, 1);
  assert.equal(led.sent[0].date, '2026-07-15');
  assert.equal(led.sent[0].first_date, '2026-06-01');
  assert.equal(led.sent[0].url, 'u2');
});
```

Append to `tools/lib/ats.test.mjs`:

```js
test('isRepost: true only when the posting date jumped >= minDays past the stored one', () => {
  assert.equal(isRepost('2026-06-01T00:00:00Z', '2026-07-10T00:00:00Z', 21), true);
  assert.equal(isRepost('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z', 21), false); // small bump = edit, not repost
  assert.equal(isRepost('', '2026-07-10T00:00:00Z', 21), false);                     // no baseline -> not a repost
  assert.equal(isRepost('2026-06-01T00:00:00Z', '', 21), false);                     // no current date -> can't judge
});
```

Append to `tools/lib/linkedin.test.mjs`:

```js
test('extractDatePosted: pulls JSON-LD datePosted, tolerant of garbage', () => {
  assert.equal(extractDatePosted('...{"@type":"JobPosting","datePosted":"2026-07-12T08:00:00.000Z"}...'), '2026-07-12');
  assert.equal(extractDatePosted('<html>no ld+json here</html>'), '');
  assert.equal(extractDatePosted(''), '');
});
```

- [ ] **Step 2: Run the three test files — expect FAIL** (functions missing).

```bash
cd ~/open_claw/workspace-jobscout/tools && node --test ledger.test.mjs lib/ats.test.mjs lib/linkedin.test.mjs 2>&1 | tail -8
```

- [ ] **Step 3: Implement `addToLedger` upsert** — replace the function in `tools/ledger.mjs:37-48`:

```js
export function addToLedger(file, items) {
  const led = read(file);
  const byId = new Map(led.sent.map((x) => [x.id, x]));
  for (const it of items) {
    const id = idOf(it);
    if (!id) continue;
    const prev = byId.get(id);
    if (prev) {
      // Re-send of a repost: refresh the record (newest send date wins) but keep the
      // original date as first_date so "how long has this been circulating" stays answerable.
      if (!prev.first_date) prev.first_date = prev.date;
      if (it.date) prev.date = it.date;
      if (it.url) prev.url = it.url;
      if (it.title) prev.title = it.title;
      if (it.company) prev.company = it.company;
    } else {
      const rec = { ...it, id };
      led.sent.push(rec);
      byId.set(id, rec);
    }
  }
  // Atomic write: this file is the ONLY dedup memory for guests — a crash mid-write
  // must never truncate it (that would re-send every past job).
  writeJsonAtomic(file, led);
  return led.sent.length;
}
```

- [ ] **Step 4: Implement `isRepost`** — append to `tools/lib/ats.mjs`:

```js
// A known posting whose date stamp jumped forward >= minDays is a REPOST (company re-opened /
// re-published the role) — it should re-enter the pipeline flagged repost:true instead of being
// seen-dropped forever (David 2026-07-15: reposted roles are re-application opportunities).
// Small forward drift (< minDays) is treated as an in-place edit, not a repost.
export function isRepost(prevUpdated, curUpdated, minDays = 21) {
  const a = Date.parse(prevUpdated || '');
  const b = Date.parse(curUpdated || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b - a >= minDays * 86400_000;
}
```

- [ ] **Step 5: Wire repost detection into `tools/ats.mjs`.** Import `isRepost` (extend the existing `lib/ats.mjs` import list). After line 93 (`const tokenCache = ...`) add:

```js
  const seenUpdated = state.seen_updated || {}; // external_id -> last surfaced `updated` stamp
```

Replace the dedup block at lines 110-112:

```js
        const known = seenSet.has(row.external_id);
        runSeen.push(row.external_id);
        if (known && !noPersist) continue;          // incremental dedup (deep scans include seen)
```
with:

```js
        const known = seenSet.has(row.external_id);
        runSeen.push(row.external_id);
        const repost = known && isRepost(seenUpdated[row.external_id], row.updated);
        if (known && !repost && !noPersist) continue; // incremental dedup (deep scans include seen)
        if (!known || repost) {
          if (row.updated) seenUpdated[row.external_id] = row.updated; // baseline for future repost checks
        }
```

In the `candidates.push({...})` object (lines 128-139) add one field after `updated: row.updated,`:

```js
          repost,
```

And include `seen_updated: seenUpdated` in the persisted state object (line 149-154):

```js
      seen_ids: pruneSeenIds([...(state.seen_ids || []), ...runSeen], SEEN_CAP),
      seen_updated: seenUpdated,
      comeet_tokens: tokenCache,
```

(Backward compatible: old state files simply lack `seen_updated` → first run rebuilds baselines, no repost fires spuriously because `isRepost('', x)` is false.)

- [ ] **Step 6: Implement `extractDatePosted`** — append to `tools/lib/linkedin.mjs`:

```js
// Pull schema.org JobPosting datePosted out of a fetched job page (present on LinkedIn
// guest job-view renderings and most server-rendered ATS pages). Returns 'YYYY-MM-DD' or ''.
export function extractDatePosted(html) {
  const m = String(html || '').match(/"datePosted"\s*:\s*"([^"]+)"/);
  if (!m) return '';
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}
```

- [ ] **Step 7: Attach `posted` during the LinkedIn vet.** In `tools/linkedin.mjs`: add `extractDatePosted` to the `lib/linkedin.mjs` import list. In `vetAll` (lines 63-74), change the per-candidate map to also capture the date:

```js
    verdicts.push(...await Promise.all(slice.map(async (c) => {
      const html = await fetchJobHtml(c.url);
      return { ...vetVerdict({ title: c.title, html, automationVet }), posted: extractDatePosted(html) };
    })));
```

And where `kept` is computed (line 194), attach it:

```js
    kept = candidates.filter((_, i) => verdicts[i].keep);
    kept.forEach((c) => { const i = candidates.indexOf(c); if (verdicts[i].posted) c.posted = verdicts[i].posted; });
```

- [ ] **Step 8: Run the three test files — expect PASS.** Same command as Step 2.

- [ ] **Step 9: Prompt changes** in `prompt-scout-person.md`:

**(a)** Replace the Step 3a paragraph (lines 134-138) with:

```markdown
**3a. Ledger check (ALWAYS — read-only in both modes):** before any Sheet work, check candidates against `P`'s sent-history:
```bash
cd ~/open_claw/workspace-jobscout/tools && node ledger.mjs <P.id> check '[{"company":"<company>","role":"<role>"}, ...]'
```
Returns `{"already":[entries],"fresh":[items-with-id]}`. Each `already` entry is the original send record `{id,title,company,date,first_date?,...}`.

**Repost triage (2026-07-15 — David wants re-application chances):** an `already` match is NOT an automatic drop. For each one, compare:
- `sent_date` = the ledger entry's `date` (last time it was sent), and Sheet status if owner (was it applied? rejected?).
- `posted_date` = the candidate's freshest posting signal: `posted` (LinkedIn), `updated` (ats:*), a date in the snippet, or `repost:true` flag from the ATS tool.
Decide like a recruiter when a re-application is worth it — there is no hard cutoff, but as guidance: the role was genuinely re-published (posted_date clearly after sent_date, or `repost:true`) AND enough time has passed since the last send/application (~3+ weeks) that a fresh submission looks intentional, not spammy. Rejections: a repost ≥ ~2 months after a rejection is fair game (teams and openings change); sooner — skip. If it qualifies → treat it as a `new_job` with `repost: true` (it flows through scoring, Sheet, and the ledger `add`, which refreshes its date). If not → keep it in the old `already` bucket for the 🔁 FYI section. When in doubt, surface it — David triages himself.
```

**(b)** In Step 6, replace the repost FYI block (lines 295-297):

```
{if repost-qualified new_jobs exist, they appear in the 🆕 list above with a 🔁 prefix:}
🔁 {title}  (score: {score}) — פורסמה מחדש!
   🏢 {company} · 📍 {location} · 🎚️ {level}
   🕐 נשלחה אליך לראשונה ב-{first_date or date}, פורסמה מחדש ב-{posted_date} — שווה להגיש שוב
   💡 {reason}
   🔗 {url}

{if any already[] entries did NOT qualify for resurfacing:}
🔁 הופיעו שוב אבל עדיין מוקדם להגשה חוזרת:
  • {company} — {title}, נשלחה ב-{DD/MM} [לא נשלחה שוב]
```

**(c)** Stale-rule carve-out — in Step 2's STALE POSTINGS bullet (line 118), append:

```markdown
Exception: a candidate carrying `repost:true` (or one you qualified as a repost in Step 3a) is judged by its REPOST date, not its original posting date — a re-published old role is fresh.
```

- [ ] **Step 10: Full suite green**

```bash
cd ~/open_claw/workspace-jobscout/tools && node --test 'lib/*.test.mjs' '*.test.mjs' 2>&1 | tail -5
```

---

### Task 4: New source providers — Workday, Amazon, SmartRecruiters, Lever-EU, Drushim

**Files:**
- Modify: `~/open_claw/workspace-jobscout/tools/lib/ats.mjs` (SUPPORTED_ATS, endpoints, normalizers, `workdayPostedToIso`)
- Modify: `~/open_claw/workspace-jobscout/tools/ats.mjs` (`fetchCompany` POST branch for workday)
- Test: `~/open_claw/workspace-jobscout/tools/lib/ats.test.mjs`

**Interfaces:**
- Consumes: canonical row shape `{external_id, title, company, location, url, updated}` (existing).
- Produces: watchlist entries may carry `wd` + `site` + `search` (workday) or `query` (amazon/drushim). `validateWatchlist` accepts the new platforms; workday additionally requires `wd` and `site`.

**⚠️ Field-name ground truth:** the API shapes below were verified live on 2026-07-15 (Workday CXS, amazon.jobs search.json, SmartRecruiters postings, Lever EU, Drushim). BEFORE writing each normalizer, fetch ONE live sample yourself and save it as a small trimmed fixture (2 rows) — if a field name differs from this plan, trust the live sample and adjust normalizer+test together:

```bash
curl -s -X POST 'https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/jobs' -H 'Content-Type: application/json' -d '{"appliedFacets":{},"limit":3,"offset":0,"searchText":"Israel QA"}' | head -c 2000
curl -s 'https://www.amazon.jobs/en/search.json?base_query=quality+engineer&loc_query=Israel&result_limit=3' | head -c 2000
curl -s 'https://api.smartrecruiters.com/v1/companies/Wix2/postings?limit=3' | head -c 2000
curl -s 'https://api.eu.lever.co/v0/postings/mobileye?mode=json' -A 'Mozilla/5.0' | head -c 2000
curl -s 'https://www.drushim.co.il/api/jobs/search?searchterm=QA%20Automation&ssaen=1' -A 'Mozilla/5.0' | head -c 3000
```

- [ ] **Step 1: Failing tests** — append to `tools/lib/ats.test.mjs` (fixtures inline, trimmed from your live samples; the shapes below are the expected contract):

```js
test('normalizeWorkday: builds public job URL + parses fuzzy postedOn', () => {
  const company = { ats: 'workday', slug: 'intel', name: 'Intel', wd: 'wd1', site: 'External' };
  const json = { jobPostings: [{ title: 'QA Automation Engineer', externalPath: '/job/Israel-Petah-Tikva/QA-Automation-Engineer_JR123', locationsText: 'Israel, Petah Tikva', postedOn: 'Posted 3 Days Ago' }] };
  const [r] = normalizeWorkday(json, company);
  assert.equal(r.external_id, 'workday:intel:JR123');
  assert.equal(r.url, 'https://intel.wd1.myworkdayjobs.com/en-US/External/job/Israel-Petah-Tikva/QA-Automation-Engineer_JR123');
  assert.ok(/^\d{4}-\d{2}-\d{2}/.test(r.updated)); // ~3 days ago, ISO
  assert.equal(r.location, 'Israel, Petah Tikva');
});

test('workdayPostedToIso: Today / Yesterday / N Days Ago / junk', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');
  assert.equal(workdayPostedToIso('Posted Today', now).slice(0, 10), '2026-07-15');
  assert.equal(workdayPostedToIso('Posted Yesterday', now).slice(0, 10), '2026-07-14');
  assert.equal(workdayPostedToIso('Posted 30+ Days Ago', now).slice(0, 10), '2026-06-15');
  assert.equal(workdayPostedToIso('', now), '');
});

test('normalizeAmazon: id, path url, posted_date', () => {
  const company = { ats: 'amazon', slug: 'amazon', name: 'Amazon' };
  const json = { jobs: [{ id_icims: '2745123', title: 'Quality Assurance Engineer', normalized_location: 'Tel Aviv, Israel', job_path: '/en/jobs/2745123/qa-engineer', posted_date: 'July 10, 2026' }] };
  const [r] = normalizeAmazon(json, company);
  assert.equal(r.external_id, 'amazon:amazon:2745123');
  assert.equal(r.url, 'https://www.amazon.jobs/en/jobs/2745123/qa-engineer');
  assert.equal(r.updated.slice(0, 10), '2026-07-10');
});

test('normalizeSmartRecruiters: releasedDate + hosted job url', () => {
  const company = { ats: 'smartrecruiters', slug: 'Wix2', name: 'Wix' };
  const json = { content: [{ id: '744000067', name: 'QA Engineer', location: { city: 'Tel Aviv-Yafo', country: 'il' }, releasedDate: '2026-07-01T08:00:00.000Z' }] };
  const [r] = normalizeSmartRecruiters(json, company);
  assert.equal(r.external_id, 'smartrecruiters:Wix2:744000067');
  assert.equal(r.url, 'https://jobs.smartrecruiters.com/Wix2/744000067');
  assert.equal(r.updated, '2026-07-01T08:00:00.000Z');
});

test('normalizeDrushim: ResultList rows -> canonical', () => {
  const company = { ats: 'drushim', slug: 'qa-automation', name: 'Drushim' };
  // Trim YOUR live fixture to this shape — adjust field paths here AND in the normalizer if the live API differs.
  const json = { ResultList: [{ Code: '9876543', JobContent: { Name: 'בודק/ת אוטומציה', Addresses: [{ CityEnglish: 'Petah Tikva' }] }, Company: { CompanyDisplayName: 'SomeCo' }, JobInfo: { Date: '2026-07-12T00:00:00' } }] };
  const [r] = normalizeDrushim(json, company);
  assert.equal(r.external_id, 'drushim:qa-automation:9876543');
  assert.ok(r.title.includes('אוטומציה'));
  assert.equal(r.company, 'SomeCo');
  assert.ok(r.url.includes('drushim.co.il'));
  assert.equal(r.updated.slice(0, 10), '2026-07-12');
});

test('validateWatchlist: accepts new platforms, workday needs wd+site', () => {
  const { companies, invalid } = validateWatchlist({ companies: [
    { ats: 'workday', slug: 'intel', wd: 'wd1', site: 'External' },
    { ats: 'workday', slug: 'broken' },
    { ats: 'amazon', slug: 'amazon' },
    { ats: 'drushim', slug: 'qa' },
    { ats: 'smartrecruiters', slug: 'Wix2' },
    { ats: 'lever-eu', slug: 'mobileye' },
  ]});
  assert.equal(companies.length, 5);
  assert.equal(invalid.length, 1);
});
```

- [ ] **Step 2: Run — expect FAIL.** `node --test lib/ats.test.mjs`

- [ ] **Step 3: Implement in `tools/lib/ats.mjs`:**

```js
export const SUPPORTED_ATS = ['comeet', 'greenhouse', 'lever', 'lever-eu', 'ashby', 'bamboohr', 'getro', 'workday', 'amazon', 'smartrecruiters', 'drushim'];
```

Add endpoints (workday is POST — the URL builder still lives here, the body is in tools/ats.mjs):

```js
  'lever-eu': (c) => `https://api.eu.lever.co/v0/postings/${c.slug}?mode=json`,
  smartrecruiters: (c) => `https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?limit=100`,
  amazon: (c) => `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(c.query || 'QA Engineer')}&loc_query=Israel&result_limit=50`,
  drushim: (c) => `https://www.drushim.co.il/api/jobs/search?searchterm=${encodeURIComponent(c.query || 'QA Automation')}&ssaen=1`,
  workday: (c) => `https://${c.slug}.${c.wd}.myworkdayjobs.com/wday/cxs/${c.slug}/${c.site}/jobs`,
```

Add normalizers + helper (full code):

```js
// Workday's list endpoint returns fuzzy "Posted N Days Ago" strings; exact dates live one
// call deeper (per-job detail) — not worth 400 extra calls. Fuzzy-to-ISO is fine for the
// freshness cut and repost baseline (day resolution).
export function workdayPostedToIso(postedOn, now = Date.now()) {
  const s = String(postedOn || '');
  if (/today/i.test(s)) return new Date(now).toISOString();
  if (/yesterday/i.test(s)) return new Date(now - 86400_000).toISOString();
  const m = s.match(/(\d+)\+?\s*days?\s+ago/i);
  if (m) return new Date(now - Number(m[1]) * 86400_000).toISOString();
  return '';
}

export function normalizeWorkday(json, company) {
  return (json?.jobPostings || []).map((p) => {
    const path = String(p.externalPath || '');
    const id = path.split('_').pop() || String(p.title || '');
    return {
      external_id: `workday:${company.slug}:${id}`,
      title: String(p.title || '').trim(),
      company: company.name || company.slug,
      location: p.locationsText || '',
      url: `https://${company.slug}.${company.wd}.myworkdayjobs.com/en-US/${company.site}${path}`,
      updated: workdayPostedToIso(p.postedOn),
    };
  });
}

export function normalizeAmazon(json, company) {
  return (json?.jobs || []).map((p) => ({
    external_id: `amazon:${company.slug}:${p.id_icims || p.id}`,
    title: String(p.title || '').trim(),
    company: company.name || 'Amazon',
    location: p.normalized_location || p.location || '',
    url: p.job_path ? `https://www.amazon.jobs${p.job_path}` : '',
    updated: (() => { const t = Date.parse(p.posted_date || ''); return Number.isFinite(t) ? new Date(t).toISOString() : ''; })(),
  }));
}

export function normalizeSmartRecruiters(json, company) {
  return (json?.content || []).map((p) => ({
    external_id: `smartrecruiters:${company.slug}:${p.id}`,
    title: String(p.name || '').trim(),
    company: company.name || company.slug,
    location: [p.location?.city, p.location?.country].filter(Boolean).join(', '),
    url: `https://jobs.smartrecruiters.com/${company.slug}/${p.id}`,
    updated: p.releasedDate || '',
  }));
}

export function normalizeDrushim(json, company) {
  return (json?.ResultList || []).map((p) => ({
    external_id: `drushim:${company.slug}:${p.Code || p.JobInfo?.JobId || String(p.JobContent?.Name || '')}`,
    title: String(p.JobContent?.Name || '').trim(),
    company: String(p.Company?.CompanyDisplayName || '').trim(),
    location: (p.JobContent?.Addresses || []).map((a) => a.CityEnglish || a.City || '').filter(Boolean).join(', '),
    url: p.Code ? `https://www.drushim.co.il/job/${p.Code}/` : 'https://www.drushim.co.il/',
    updated: p.JobInfo?.Date || '',
  }));
}
```

Register them:

```js
export const normalizers = {
  comeet: normalizeComeet,
  greenhouse: normalizeGreenhouse,
  lever: normalizeLever,
  'lever-eu': (json, company) => normalizeLever(json, company).map((r) => ({ ...r, external_id: r.external_id.replace(/^lever:/, 'lever-eu:') })),
  ashby: normalizeAshby,
  bamboohr: normalizeBamboo,
  getro: normalizeGetro,
  workday: normalizeWorkday,
  amazon: normalizeAmazon,
  smartrecruiters: normalizeSmartRecruiters,
  drushim: normalizeDrushim,
};
```

Update `validateWatchlist` ok-rule (line 136):

```js
    const ok = c && SUPPORTED_ATS.includes(c.ats) && c.slug
      && (c.ats !== 'comeet' || c.uid)
      && (c.ats !== 'workday' || (c.wd && c.site));
```

- [ ] **Step 4: POST branch in `tools/ats.mjs`.** Add below `fetchJson` (line 44):

```js
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
    } finally { clearTimeout(t); }
  }
  return { jobPostings: all };
}
```

And extend `fetchCompany` (lines 61-68):

```js
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
```

- [ ] **Step 5: Run tests — expect PASS.** `node --test lib/ats.test.mjs`

- [ ] **Step 6: Live smoke test (read-only, no WhatsApp).** Temporarily verify against the real APIs via a scratch watchlist — do NOT touch David's state:

```bash
cd ~/open_claw/workspace-jobscout/tools && node -e "
import('./lib/ats.mjs').then(async (m) => {
  const r = await fetch('https://api.smartrecruiters.com/v1/companies/Wix2/postings?limit=5');
  const rows = m.normalizeSmartRecruiters(await r.json(), { ats:'smartrecruiters', slug:'Wix2', name:'Wix' });
  console.log(rows.slice(0,2));
});"
```
Expected: 2 canonical rows with real titles + ISO `updated`. Repeat the pattern for drushim and (via a tiny POST script) workday-intel. If any live shape differs from the fixture, fix normalizer+fixture NOW.

---

### Task 5: Config — watchlist seeds + Tavily dork revamp

**Files:**
- Modify: `~/open_claw/workspace-jobscout/people/david/company-watchlist.json`
- Modify: `~/open_claw/workspace-jobscout/people/david/sources.json` (`tavily` block)

- [ ] **Step 1: Append new companies** to the `companies` array in `company-watchlist.json`:

```json
    { "ats": "workday", "slug": "intel", "name": "Intel", "wd": "wd1", "site": "External", "search": "Israel QA" },
    { "ats": "workday", "slug": "nvidia", "name": "NVIDIA", "wd": "wd5", "site": "NVIDIAExternalCareerSite", "search": "Israel QA" },
    { "ats": "amazon", "slug": "amazon", "name": "Amazon", "query": "quality assurance engineer" },
    { "ats": "amazon", "slug": "amazon-sdet", "name": "Amazon", "query": "SDET" },
    { "ats": "smartrecruiters", "slug": "Wix2", "name": "Wix" },
    { "ats": "lever-eu", "slug": "mobileye", "name": "Mobileye" },
    { "ats": "drushim", "slug": "qa-automation", "name": "Drushim", "query": "QA Automation" },
    { "ats": "drushim", "slug": "automation-engineer", "name": "Drushim", "query": "Automation Engineer" },
    { "ats": "drushim", "slug": "sdet", "name": "Drushim", "query": "SDET" }
```

- [ ] **Step 2: Replace the `tavily` block** in `sources.json`:

```json
  "tavily": {
    "_comment": "Revamped 2026-07-15: ATS X-ray across ALL major platforms (was comeet+greenhouse only). site: operators in the query text are honored by Tavily (validated 2026-07-02 on comeet). time_range widened day->week for recall — the ledger/Sheet dedup + repost triage absorb re-hits. Morning run only (afternoon skips Tavily, quota). ~9 queries/day ≈ 270 credits/mo of the 1000 quota.",
    "queries": [
      {"query": "QA Automation Engineer Israel site:comeet.com/jobs", "max": 8},
      {"query": "SDET OR \"Software Engineer in Test\" Israel site:comeet.com/jobs", "max": 5},
      {"query": "QA Automation Engineer Israel site:job-boards.greenhouse.io", "max": 6},
      {"query": "QA Automation Tel Aviv OR Israel site:jobs.lever.co", "max": 5},
      {"query": "QA Automation Engineer Israel site:apply.workable.com", "max": 5},
      {"query": "QA OR Automation Engineer Israel site:jobs.ashbyhq.com", "max": 4},
      {"query": "QA Automation Israel site:careers.smartrecruiters.com", "max": 4},
      {"query": "QA Automation Engineer Israel site:myworkdayjobs.com", "max": 5},
      {"query": "\"Automation Engineer\" OR \"QA Engineer\" \"Petah Tikva\" OR \"פתח תקווה\"", "max": 5}
    ],
    "time_range": "week",
    "search_depth": "basic"
  },
```

Note: `search.mjs` maps `time_range:"week"` to the ` past week` recency hint (line 151) — no code change needed.

- [ ] **Step 3: Validate + read-only source test**

```bash
node -e "JSON.parse(require('fs').readFileSync('/home/davidtobol2580/open_claw/workspace-jobscout/people/david/company-watchlist.json','utf8')); JSON.parse(require('fs').readFileSync('/home/davidtobol2580/open_claw/workspace-jobscout/people/david/sources.json','utf8')); console.log('json ok')"
cd ~/open_claw/workspace-jobscout/tools && node ats.mjs --person david --no-persist 2>&1 | tail -3
cd ~/open_claw/workspace-jobscout/tools && node search.mjs --person david 2>&1 | tail -2
```
Expected: `json ok`; ats.mjs returns `ok:true` with candidates including new-platform sources (`ats:workday`, `ats:drushim`, ...) and NO state write; search.mjs returns `ok:true` (uses ~9 Tavily credits — acceptable, once). Petah Tikva check: `node ats.mjs --person david --no-persist 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.candidates.filter(c=>/petah|פתח/i.test(c.location+c.snippet)).length + ' PT candidates')})"` — expect ≥1 from Intel.

---

### Task 6: Weekly company-discovery step

**Files:**
- Modify: `~/open_claw/workspace-jobscout/skills/job-scout/prompt-weekly-review.md`

- [ ] **Step 1: Append a discovery section** at the end of the weekly-review prompt:

```markdown
## Company discovery (added 2026-07-15 — grow the watchlist automatically)

After the lessons file is written, run ONE Tavily discovery pass to find Israeli companies hiring QA/automation on ATS platforms we poll:
```bash
cd ~/open_claw/workspace-jobscout/tools && node search.mjs --person david
```
From the results, extract company slugs NOT already in `people/david/company-watchlist.json`:
- `comeet.com/jobs/<slug>/<uid>` → `{ats:"comeet", slug, uid, name}`
- `job-boards.greenhouse.io/<token>` → `{ats:"greenhouse", slug: token, name}`
- `jobs.lever.co/<slug>` → `{ats:"lever", slug, name}` (`jobs.eu.lever.co` → `lever-eu`)
- `jobs.ashbyhq.com/<org>` → `{ats:"ashby", slug: org, name}`
- `careers.smartrecruiters.com/<Company>` → `{ats:"smartrecruiters", slug, name}`
Append the new entries to the `companies` array in `people/david/company-watchlist.json` (valid JSON — re-read the file after writing to confirm it parses). List every added company in the weekly report under `🏢 חברות חדשות ל-watchlist:`. If none found, say so in one line. Cap: add at most 10 per week.
```

- [ ] **Step 2: Verify** the file still reads coherently (`grep -n "Company discovery" prompt-weekly-review.md`).

---

### Task 7: Full verification gate (code tasks done)

- [ ] **Step 1:** `cd ~/open_claw/workspace-jobscout && node tools/self-edit.mjs verify` — Expected: `ok` (full unit suite + syntax + config parse). If FAIL: fix, or `node tools/self-edit.mjs revert <Task-0 id>` and report.
- [ ] **Step 2:** Log the change: `node tools/self-edit.mjs log '{"change":"2026-07-15 overhaul: seniority relaxation (junior:false/internships:true, min_score 50), repost resurfacing (ledger upsert + ats seen_updated + linkedin datePosted), +5 providers (workday/amazon/smartrecruiters/lever-eu/drushim), tavily x-ray revamp"}'` (match the CLI signature — check `node tools/self-edit.mjs` usage line first).
- [ ] **Step 3:** Read-only end-to-end sanity per source (NO full scout):

```bash
cd ~/open_claw/workspace-jobscout/tools
node linkedin.mjs --person david --window-days 3 --no-persist 2>&1 | tail -2
node ats.mjs --person david --no-persist 2>&1 | tail -2
```
Expected: both `ok:true`; LinkedIn candidates now include junior-titled QA roles (junior no longer dropped) and some carry `posted`.

---

### Task 8: One-time full backfill run (LIVE — the deliberate exception)

**Files:**
- Create: `~/open_claw/workspace-jobscout/skills/job-scout/prompt-backfill-david.md`
- Modify: `~/open_claw/workspace-jobscout/skills/job-scout/SKILL.md` (mode routing: `backfill` → the new prompt)

- [ ] **Step 1: Write `prompt-backfill-david.md`** — a one-shot variant of `prompt-scout-person.md` (person hardcoded `david`, MODE LIVE). Full content:

```markdown
# One-time FULL BACKFILL — David only (2026-07-15, requested by David)

You run a ONE-TIME comprehensive sweep for person `david`. Unlike the daily scout: NO seniority
filter, NO score threshold, NO sent-ledger drop. Role-field + location filters stay. Everything
goes to the Sheet; WhatsApp gets a summary + top-20. At the end, state IS persisted so tomorrow's
daily run reports only genuinely-new jobs.

Read `people/david/profile/cv-summary.json` first (scoring context). Paths/tools as in prompt-scout-person.md.

## 1. Gather EVERYTHING (persist ON — this run becomes the new baseline)
```bash
cd ~/open_claw/workspace-jobscout/tools
node search.mjs --person david
node linkedin.mjs --person david --window-days 30        # deep sweep, persists seen
node telegram.mjs fetch --person david
node ats.mjs --person david --window-days 90             # wide freshness window, persists seen + seen_updated
```
Note: linkedin/ats will mostly return already-seen ids as skipped — that is fine; the point of
--window-days here is maximum reach for NEW ids. For full coverage of PREVIOUSLY-DROPPED jobs,
ALSO run: `node linkedin.mjs --person david --window-days 30 --no-persist` and
`node ats.mjs --person david --no-persist` and merge those candidates in (they include seen jobs).

## 2. Score all candidates (Step 2 of prompt-scout-person.md) — but KEEP EVERYTHING except:
- internships/student/trainee
- clearly off-field roles (not QA/test/automation)
- excluded_sectors / exclusion_signals from cv-summary.json
- postings verifiably closed
Assign level + score + Hebrew reason to every kept candidate. Do NOT drop on score or level.

## 3. Dedup: ONLY against Sheet rows whose status is ✅ Applied / 📞 Interview / 🎉 Offer with
found_at within the last 30 days (those are live applications — skip). Everything else —
including ledger-known and previously-rejected/expired rows — is IN (mark ledger-known ones `repost: true`).

## 4. Sheet: append ALL kept candidates (one `sheet.mjs append` call, id via jobkey.mjs, status
"⏳ Pending", note `בקפיצת בסיס 15/07` on each). For candidates matching an EXISTING row, update
that row instead of appending (avoid duplicate rows). Then `node sheet.mjs sort`.

## 5. WhatsApp (ONE message to the shared group, Hebrew):
```
@<David's e164> 🔵 סריקת עומק חד-פעמית הושלמה! — {DD/MM}
סרקתי את כל המקורות מחדש בלי פילטרים: {N} משרות פתוחות רלוונטיות נמצאו ({X} חדשות, {Y} הופעות-מחדש).
🏆 טופ 20 לפי התאמה:
1. {title} (score: {score}) — {company} · {location} · 🎚️ {level}
   🔗 {url}
...
📋 הכל בגיליון (ממוין לפי ציון): {sheet_url}
מחר בבוקר חוזרים למשטר הרגיל — רק משרות חדשות. 🤖
```

## 6. Ledger: `node ledger.mjs david add '[...]'` for EVERY job in the Sheet output of this run
(so the daily scout never re-sends them as new).

## 7. Log `data/runs/<date>-david-backfill.json` `{"date","person":"david","mode":"backfill","candidates":N,"kept":N,"sent":true}`.

End with exactly `NO_REPLY`.
```

- [ ] **Step 2: Route it** — in `SKILL.md`'s mode-routing section add: `- message contains "backfill" or "סריקת בסיס" (owner only) → run prompt-backfill-david.md`.

- [ ] **Step 3: TRIGGER the run** (this sends real WhatsApp — David approved 2026-07-15 "שיריץ גם פעם אחת בצורה מלאה בלי הסינונים"):

```bash
cd ~/open_claw && ./openclaw agent turn --agent main --message "backfill — run skills/job-scout/prompt-backfill-david.md exactly. MODE: LIVE."
```
(Confirm the exact CLI verb for a one-off agent turn by checking `./openclaw --help` — the dry-run on 2026-07-15 07:14 was triggered the same way; mirror whatever invocation that session used, visible in `/tmp/openclaw/openclaw-2026-07-15.log` around 07:14Z.)

- [ ] **Step 4: Verify:** WhatsApp message arrived (ask David / check `openclaw` log for the send), Sheet row count grew, `data/runs/2026-07-15-david-backfill.json` exists, `people/david/data/sent-suggestions.json` grew, seen ledgers' `last_run` = today.

---

### Task 9: Daily interactive interview question

**Files:**
- Create: `~/open_claw/workspace-jobscout/skills/job-scout/prompt-daily-question.md`
- Modify: `~/open_claw/workspace-jobscout/skills/job-scout/SKILL.md` (mode routing + cron note)
- Modify: `~/open_claw/workspace-jobscout/skills/job-scout/prompt-qa.md` (grading path)
- Create (runtime): `~/open_claw/workspace-jobscout/data/learning/questions.jsonl`, `data/learning/progress.md`
- OpenClaw cron job: daily 08:33 Asia/Jerusalem

- [ ] **Step 1: Write `prompt-daily-question.md`:**

```markdown
# Daily Interview Question — David (senior QA-Automation track)

You send David ONE interview-grade question per day in the shared WhatsApp group. Level: what a
SENIOR automation developer is expected to answer in a real Israeli tech interview. Hebrew wrapper,
technical terms may stay English.

## 1. Load history + weak points
```bash
mkdir -p ~/open_claw/workspace-jobscout/data/learning
tail -30 ~/open_claw/workspace-jobscout/data/learning/questions.jsonl 2>/dev/null
cat ~/open_claw/workspace-jobscout/data/learning/progress.md 2>/dev/null
```

## 2. Pick a question — NEVER one already in questions.jsonl. Rotate topics (pick the least-recently-used;
bias toward progress.md weak topics 2:1): (1) Selenium/Playwright internals — waits, locators, PO model,
shadow DOM; (2) API testing — REST/contract/auth/idempotency; (3) test architecture — pyramid, flaky
tests, parallelism, data management; (4) CI/CD — pipelines, quality gates, docker, sharding; (5) coding —
a short JS/Python exercise interviewers actually give (string/array/async); (6) SQL + data validation;
(7) performance/load basics; (8) mobile (Appium) basics; (9) senior behavioral — estimation, bug advocacy,
test strategy for a new feature. Difficulty: start senior-standard; adjust per progress.md.

## 3. Send (ONE message):
```bash
~/open_claw/openclaw message send --channel whatsapp --target "<shared.whatsapp_group_id from .config/people.json>" --message "<the message>"
```
Format:
```
🎓 שאלת היום למפתח אוטומציה סניור — {DD/MM}
❓ {השאלה — קצרה וממוקדת, כמו מראיין}
💡 מושג היום: {מושג שסביר שדוד לא מכיר} — {הסבר של 2-3 משפטים + למה זה עולה בראיונות}
(ענה כאן בקבוצה ואבדוק אותך כמו מראיין 😉)
```

## 4. Log it:
```bash
echo '{"date":"<YYYY-MM-DD>","topic":"<topic>","question":"<the question>","concept":"<the concept>","answered":false}' >> ~/open_claw/workspace-jobscout/data/learning/questions.jsonl
```

End with exactly `NO_REPLY`.
```

- [ ] **Step 2: Grading path** — append to `prompt-qa.md`:

```markdown
## Daily-question answers (added 2026-07-15)

If David's message answers the latest entry in `data/learning/questions.jsonl` (check `tail -1`; `answered:false`
and the message is on-topic): act as a strict-but-supportive interviewer, in Hebrew —
1. ציון קצר (מצוין/טוב/חלקי/פספוס) + מה היה חסר כדי שזו תהיה תשובת סניור מלאה.
2. התשובה המלאה כפי שמראיין היה רוצה לשמוע (תמציתית).
3. שאלת המשך אחת קצרה אם מתבקש, או טיפ אחד לריאיון אמיתי.
Then: rewrite the jsonl line with `"answered":true,"grade":"<grade>"`, and update
`data/learning/progress.md` — keep it a short file: strong topics, weak topics (with dates), level
calibration note. Weak topics get asked again within a week (prompt-daily-question reads this file).
```

- [ ] **Step 3: Route** — in `SKILL.md` mode routing add: `- cron message contains "daily-question" → run prompt-daily-question.md`.

- [ ] **Step 4: Create the cron job.** The live cron store is `~/.openclaw/cron/jobs.json.migrated` (tz Asia/Jerusalem). First check for a CLI: `cd ~/open_claw && ./openclaw cron --help`. If a `cron add` verb exists, use it: schedule `33 8 * * *`, agent `main`, message: `daily-question — run skills/job-scout/prompt-daily-question.md (owner: david). MODE: LIVE.` If NO CLI verb exists, copy an existing job object in the store file (e.g. the 15:00 one), give it a fresh uuid, the new schedule + message, `enabled:true`, then restart the gateway while chat is idle (`openclaw gateway restart`) per `~/.openclaw/CLAUDE.md` rules.
- [ ] **Step 5: Fire the FIRST question NOW** (David asked to receive it + the cron for calibration): trigger one agent turn with the same `daily-question` message used in the cron (same invocation style as Task 8 Step 3). Verify the WhatsApp message landed and `data/learning/questions.jsonl` has 1 line.

---

### Task 10: CV ATS-compatibility audit (analysis deliverable, no code)

- [ ] **Step 1: Locate the CV:** `ls ~/open_claw/workspace-jobscout/people/david/profile/` (expect a PDF/DOCX near `cv-summary.json`; if absent, search `find ~/open_claw -iname '*cv*' -o -iname '*resume*' -o -iname '*קורות*' 2>/dev/null | grep -vi node_modules`).
- [ ] **Step 2: Parse like an ATS:** `pdftotext -layout <cv.pdf> - | head -100` (install check: `which pdftotext`; fallback `python3 -c "import sys;from pypdf import PdfReader;print('\n'.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))" <cv.pdf>`). Judge: does the text extract in correct reading order? Are name/phone/email/city present as plain text? Do section headers (Experience/Education/Skills) survive? Tables/columns/graphics that scramble extraction?
- [ ] **Step 3: Keyword coverage:** compare extracted text against the target-role vocabulary (from `cv-summary.json` + david's `sources.json` keywords): QA Automation, SDET, Selenium/Playwright, API testing, CI/CD, Python/JS/Java, SQL. List present/missing.
- [ ] **Step 4: Write the report** (Hebrew) to `~/open_claw/workspace-jobscout/data/tmp/cv-ats-audit-2026-07-15.md`: parseability verdict, missing keywords, formatting hazards, concrete fixes (each: what to change + why ATSs care). Deliver the summary to David in the Claude Code session (NOT WhatsApp).

---

### Task 11: Docs, memory, live watch

- [ ] **Step 1:** Update `~/open_claw/workspace-jobscout/skills/job-scout/SKILL.md` hard-rules/tool-table if any new file isn't reflected; add one line to the workspace `CLAUDE.md`/docs where the pipeline is described (new sources + new policy, dated 2026-07-15).
- [ ] **Step 2:** Verify next cron end-to-end: after the next 08:00 (or 15:00) run, check `data/runs/<date>-david.json` (`kept`/`new` counts should rise vs the 0-2/day baseline), drops.jsonl shows `internship` not `junior` reasons for david, no errors in `/tmp/openclaw/openclaw-<date>.log` for tavily/ats.
- [ ] **Step 3:** Session memory checkpoint (main session writes it — not the sub-agent).
