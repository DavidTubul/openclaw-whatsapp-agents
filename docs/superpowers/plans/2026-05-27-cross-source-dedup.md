# Cross-Source Dedup + Uniform Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace URL-based dedup with content-based (company+role) dedup so a job from any source lands as ONE normalized Sheet row listing all its sources.

**Architecture:** A small deterministic key tool (`jobkey.mjs`) produces a stable `sha256(normCompany|normRole)[:12]` id; the scout prompt is rewritten to merge candidates by company+role (LLM semantic layer + the deterministic id), record a single row per job with joined sources and primary/secondary links, normalize every field before writing, and fix the Gmail Step 5b path to match by company+role instead of URL.

**Tech Stack:** Node 22 (ESM), `node:crypto`, `node --test`. No Sheet schema / Apps Script change.

**Note — no git:** This project is not a git repo. Where the standard plan would `git commit`, use a **verification checkpoint** (run a command, confirm output). Do not run git.

---

## File Structure

- **Create** `workspace/tools/jobkey.mjs` — CLI: `node jobkey.mjs "<company>" "<role>"` → 12-char content id; also exports `normalize`, `jobId` for testing.
- **Create** `workspace/tools/jobkey.test.mjs` — `node --test` assertions for normalization + id stability.
- **Modify** `workspace/skills/job-scout/prompt-scout.md` — rewrite Step 3 (content dedup + merge), adjust Step 4 (content id + normalized fields + joined source), add normalization rules to Step 2, fix Step 5b (company+role match).
- **Modify** `workspace/skills/job-scout/SKILL.md` — add `jobkey.mjs` to the Real tools table.
- **Modify** `CLAUDE.md` — note new dedup scheme + `jobkey.mjs` in tools list.

---

## Task 1: Create `jobkey.mjs` (normalization + content id)

**Files:**
- Create: `workspace/tools/jobkey.mjs`
- Create: `workspace/tools/jobkey.test.mjs`

- [ ] **Step 1: Write the tool**

Create `workspace/tools/jobkey.mjs`:

```js
#!/usr/bin/env node
// Deterministic content key for a job, so dedup is stable across sources/runs.
//   node jobkey.mjs "<company>" "<role>"  -> prints sha256(normCompany|normRole)[:12]
// Also exports normalize() and jobId() for tests and reuse.
import { createHash } from 'node:crypto';

// Lowercase, strip company suffixes, remove emojis/punctuation, collapse whitespace.
export function normalize(s) {
  if (s == null) return '';
  let t = String(s).toLowerCase();
  // Remove emojis & most symbol/pictograph ranges.
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, ' ');
  // Strip common company suffixes (word-boundary, with/without dot).
  t = t.replace(/\b(ltd|inc|llc|co|corp|gmbh)\.?\b/g, ' ');
  t = t.replace(/בע["'`]?מ/g, ' '); // Hebrew בע"מ variants
  // Remove punctuation (keep letters/digits/whitespace, incl. Hebrew).
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Collapse whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function jobId(company, role) {
  const c = normalize(company);
  const r = normalize(role);
  if (!c || !r) return null;
  return createHash('sha256').update(`${c}|${r}`).digest('hex').slice(0, 12);
}

function main() {
  const [company, role] = process.argv.slice(2);
  const id = jobId(company, role);
  if (!id) {
    process.stderr.write('jobkey: both <company> and <role> are required and must be non-empty after normalization\n');
    process.exit(1);
  }
  process.stdout.write(id + '\n');
}

// Run main only when invoked directly (not when imported by tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

- [ ] **Step 2: Write the failing test**

Create `workspace/tools/jobkey.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, jobId } from './jobkey.mjs';

test('normalize strips suffix, case, emoji, punctuation', () => {
  assert.equal(normalize('SolarEdge Ltd. 🚀'), 'solaredge');
  assert.equal(normalize('JFrog בע"מ'), 'jfrog');
});

test('same company+role in different forms => same id', () => {
  const a = jobId('SolarEdge Ltd.', 'QA Automation Engineer');
  const b = jobId('solaredge', 'qa automation engineer');
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

test('different roles at same company => different ids', () => {
  const a = jobId('Acme', 'QA Automation Engineer');
  const b = jobId('Acme', 'Senior SDET');
  assert.notEqual(a, b);
});

test('missing company or role => null', () => {
  assert.equal(jobId('', 'QA'), null);
  assert.equal(jobId('Acme', '  '), null);
});
```

- [ ] **Step 3: Run the test — expect PASS**

Run: `cd ~/open_claw/workspace/tools && node --test jobkey.test.mjs`
Expected: `# pass 4`, `# fail 0`. (Implementation is written in Step 1, so this passes immediately and locks behavior.)

- [ ] **Step 4: Verify the CLI directly**

Run: `cd ~/open_claw/workspace/tools && node jobkey.mjs "SolarEdge Ltd." "QA Automation Engineer"; echo "---"; node jobkey.mjs "solaredge" "qa automation engineer"`
Expected: the two ids printed are identical, 12 hex chars each.

Run: `cd ~/open_claw/workspace/tools && node jobkey.mjs "" "QA"; echo "exit=$?"`
Expected: stderr message about required args, `exit=1`.

---

## Task 2: Rewrite Step 3 of the scout pipeline (content dedup + merge)

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md` (Step 3 block, currently `prompt-scout.md:31-40`)

- [ ] **Step 1: Replace the Step 3 section**

In `workspace/skills/job-scout/prompt-scout.md`, replace the entire "## Step 3 — Dedupe against the Sheet" section (from its heading through the line ending `Remaining = \`new_jobs\`.`) with:

````markdown
## Step 3 — Merge duplicates & dedupe against the Sheet (content-based)

Dedup is by **company + role**, NOT by URL — the same job appears under different URLs across sources.

**3a. Read full existing rows:**
```bash
cd ~/open_claw/workspace/tools && node sheet.mjs read
```
For each existing row capture: `sheet_row, id (A), role (D), company (E), source (C), url (J), status (K)`.

**3b. Merge duplicates WITHIN this run (intra-batch):** Cluster the kept candidates by (company + role) using your own semantic judgment (e.g. "QA Automation" ≈ "Automation QA"; same company). Collapse each cluster into ONE canonical candidate:
- `source` = the distinct sources joined with ` + ` (e.g. `linkedin + telegram`).
- primary `url` = the best apply link — **prefer a board/company URL over a Telegram permalink**.
- secondary links → collect for the notes column, e.g. `גם בטלגרם: <permalink>`.
- keep the highest `score` and its `reason`.

**3c. Dedupe each canonical candidate against existing rows:** Compute its content id:
```bash
cd ~/open_claw/workspace/tools && node jobkey.mjs "<company>" "<role>"
```
Match it to existing rows two ways: (1) id equals an existing row's `id`; (2) semantic company+role match to a row you read in 3a (covers legacy rows whose id is URL-based). Then:
- **Match found AND this candidate carries a source not already in that row's `source` (col C):** update the existing row to add the source and the secondary link — do NOT resend to WhatsApp:
  ```bash
  cd ~/open_claw/workspace/tools && node sheet.mjs update <sheet_row> '{"source":"<joined sources>","notes":"<existing notes + secondary link>"}'
  ```
- **Match found, no new source:** drop the candidate.
- **No match:** it is genuinely new → it goes to Step 4 as a `new_job` (carry its computed content id).

If `node jobkey.mjs` exits non-zero for a candidate (missing company/role), fall back to the semantic match only and continue (log to stderr). If `sheet.mjs read` fails, skip 3a/3c merging for this run and treat all kept candidates as new (log to stderr) — never crash the run.
````

- [ ] **Step 2: Verification checkpoint — Step 3 references the new tools/logic**

Run: `grep -c "jobkey.mjs\|content-based\|intra-batch\|company + role" ~/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: ≥ 3 matches. And confirm the old URL-hash instruction is gone:
Run: `grep -c "sha256sum | cut -c1-12" ~/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: `0`.

---

## Task 3: Update Step 4 (append) for content id + normalized fields + joined source

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md` (Step 4 block, currently around `prompt-scout.md:42-48`)

- [ ] **Step 1: Replace the Step 4 section**

Replace the "## Step 4 — Append new jobs to the Sheet" section with:

````markdown
## Step 4 — Append new jobs to the Sheet

For all `new_jobs`, build a JSON array of row objects and append in ONE call. Use the **content id** from Step 3c (`jobkey.mjs`), the joined `source`, the primary `url`, and put any secondary links in `notes`. All fields must be normalized (see Step 2 "Uniform presentation").
```bash
cd ~/open_claw/workspace/tools && node sheet.mjs append '[{"id":"<content id>","found_at":"<YYYY-MM-DD>","source":"<joined sources>","title":"<normalized role>","company":"<normalized company>","location":"<canonical location>","level":"<level>","score":<score>,"reason":"<hebrew reason>","url":"<primary url>","notes":"<secondary links or empty>","status":"⏳ Pending"}, ...]'
```
Confirm `appended` equals the number of new_jobs.
````

- [ ] **Step 2: Verification checkpoint**

Run: `grep -c "content id\|joined sources\|normalized role" ~/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: ≥ 3 matches.

---

## Task 4: Add uniform-presentation rules to Step 2

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md` (Step 2 section)

- [ ] **Step 1: Append a normalization subsection**

In `workspace/skills/job-scout/prompt-scout.md`, at the END of the "## Step 2 — CV-match scoring" section (after the `KEEP a candidate only if ...` line), add:

````markdown
### Step 2b — Uniform presentation (normalize every kept candidate before Steps 3–4)

Whatever the source, normalize each field so all rows look the same in the Sheet and WhatsApp:
- **role (title):** a clean canonical job title only — strip emojis, the company name, location, dates, and marketing text. From a free-text Telegram post, extract just the role (e.g. a long post → `QA Automation Team Leader`). Use consistent terms: `QA Automation Engineer`, `Senior Automation Engineer`, `SDET`, etc.
- **company:** clean name, no `בע"מ`/`Ltd`/`Inc`, no emojis.
- **location:** one canonical city (the matched allowed-city); remote → `Remote-IL`; unknown → leave blank (never guess).
- **reason:** Hebrew, 1–2 sentences, same format for all sources.
````

- [ ] **Step 2: Verification checkpoint**

Run: `grep -c "Step 2b\|Uniform presentation\|never guess" ~/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: ≥ 2 matches.

---

## Task 5: Fix Gmail Step 5b to match by company + role

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md` (Step 5b block, currently around `prompt-scout.md:72-83`)

- [ ] **Step 1: Replace the Step 5b opening instruction**

In the "### Step 5b — Enrich new \"applied\" rows" section, replace the first paragraph (the sentence beginning "For any **applied** email where no matching row exists in the Sheet yet (new company), append a basic row:") and its code block with:

````markdown
For any **applied** email, FIRST match it to an existing Sheet row by **company + role** (not by URL): compare the email's company/role to the rows read in Step 5. If a row matches, just update its status (do NOT append):
```bash
cd ~/open_claw/workspace/tools && node sheet.mjs update <sheet_row> '{"status":"✅ Applied","applied_at":"<YYYY-MM-DD>","email_snippet":"<subject, first 100 chars>"}'
```
Only if NO existing row matches by company+role, append a new basic row (use the content id from `node jobkey.mjs "<company>" "<title>"`):
```bash
cd ~/open_claw/workspace/tools && node sheet.mjs append '[{"id":"<content id>","found_at":"<date>","source":"gmail-self-apply","title":"<from subject>","company":"<company>","status":"✅ Applied","applied_at":"<date>","email_snippet":"<subject>"}]'
```
````

- [ ] **Step 2: Verification checkpoint**

Run: `grep -c "match it to an existing Sheet row by \*\*company + role\|do NOT append" ~/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: ≥ 1 match. Confirm the old "no matching row exists ... append a basic row" wording is replaced:
Run: `grep -c "where no matching row exists in the Sheet yet (new company), append" ~/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: `0`.

---

## Task 6: Documentation

**Files:**
- Modify: `workspace/skills/job-scout/SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `jobkey.mjs` to SKILL.md tool table**

In `workspace/skills/job-scout/SKILL.md`, add a row to the "Real tools" table after the Sheet row:
```
| Content dedup key | `node ~/open_claw/workspace/tools/jobkey.mjs "<company>" "<role>"` (→ stable 12-char id for company+role dedup) |
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`:
1. In the `tools/` tree block, add after the `sheet.mjs` line:
   `│   ├── jobkey.mjs            # content dedup key: sha256(company|role)[:12]`
2. Find the sentence describing the sheet id (`A id(sha256[:12] of URL)`) in the "Sheet columns" section and change it to: `A id(sha256[:12] of normalized company|role)`.

- [ ] **Step 3: Verification checkpoint**

Run: `grep -c "jobkey" ~/open_claw/workspace/skills/job-scout/SKILL.md ~/open_claw/CLAUDE.md; grep -c "company|role" ~/open_claw/CLAUDE.md`
Expected: both files report ≥1 `jobkey`; CLAUDE.md reports ≥1 `company|role`.

---

## Final verification

- [ ] `node --test workspace/tools/jobkey.test.mjs` → `# pass 4`.
- [ ] `node jobkey.mjs "SolarEdge Ltd." "QA Automation Engineer"` and `node jobkey.mjs "solaredge" "qa automation engineer"` → identical id.
- [ ] prompt-scout.md: Step 3 is content-based (no `sha256sum | cut`), Step 4 uses content id + joined source, Step 2b normalization present, Step 5b matches by company+role.
- [ ] SKILL.md + CLAUDE.md updated.
- [ ] (Optional live) Re-run scout; a job in both Telegram and a board produces ONE row with `source` listing both; a Gmail "applied" for an existing company updates instead of appends.
