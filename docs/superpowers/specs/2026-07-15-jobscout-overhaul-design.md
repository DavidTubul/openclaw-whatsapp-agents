# Job-Scout ("Scotty") Overhaul — Design Spec

Date: 2026-07-15 · Approved by David (session grilling, all decisions below are his)
Scope: `workspace-jobscout` (agent `main`). All policy changes apply to person `david` only; guests (yossi/yuval/uri) keep current behavior.

## Background (evidence from the 2026-07-15 audit)

- Pipeline is healthy: cron runs complete (08:00 + 15:00 IL), LinkedIn/ATS fetch daily (seen ledgers updated 2026-07-15). The "no new jobs" dry-up is filter+dedup saturation, not a fetch failure.
- Drop histogram (last 2 days, 400 drops): off-field 237, management 74, location 74, junior 12, manual-only 3.
- Tavily was hard-broken 2026-07-14 14:42 → 2026-07-15 07:55 (SecretRef migration); FIXED 07:55 UTC (key now via systemd env). Verified working post-fix. No code change needed; `.config/job-scout.json` `tavily_secret_ref` leftover may be cleaned.
- Petah Tikva: correctly present in `people/david/allowed-locations.json` (en+he variants). PT jobs ARE fetched; all 20 recent PT drops were off-field/management/junior — zero location drops. PT coverage improves via new sources (Intel Workday has PT roles), not via location fixes.

## Decisions (David, 2026-07-15)

| # | Decision |
|---|---|
| D1 | Seniority: junior/mid/unspecified all pass, from ANY company. Internships/student/trainee still always dropped. |
| D2 | Score threshold 70 → **50**. No daily volume cap. |
| D3 | Role scope unchanged: QA/automation/SDET only (off-field + management filters stay). |
| D4 | Reposts: resurface a previously-sent (even applied) job when it is genuinely reposted; the LLM weighs time-since-sent AND repost date to decide the "ideal time"; tag 🔁 + recommend re-applying. |
| D5 | One-time full backfill run: no seniority filter, no score threshold, ignore sent/seen ledgers (skip only applied-and-fresh); role+location filters stay. Everything → Google Sheet sorted by score; WhatsApp gets summary + top-20 + sheet link. Run persists seen-state so subsequent days show only new jobs. Run now. |
| D6 | Daily interview question: interactive (Scotty asks → David answers in group → Scotty grades like an interviewer, corrects, teaches + 1 new concept). Sent ~08:30 IL after the morning jobs report. Senior QA-automation level. Send first question + cron definition to David for calibration feedback. |
| D7 | CV ATS-compatibility audit for David's CV. |

## Changes

### 1. Seniority/score policy (config + prompt + lib)

- `tools/lib/linkedin.mjs` — restructure `titleHardExcluded`: intern check becomes independent of `filter.junior` (new flag semantics: `internships: true` always active for david; `junior: false` disables the junior drop). Keep MGMT + off-field checks unchanged.
- `people/david/sources.json` — `title_filter.junior: false`; `junior_exempt_big_companies` list removed from filter logic for david (harmless to keep the key; logic must not require it).
- `tools/ats.mjs:115` — bug fix: pass `company` arg to `titleHardExcluded` (correctness for guests who keep junior filtering).
- `skills/job-scout/prompt-scout-person.md` Step 2 — for david: KEEP if level ∈ {senior, mid, junior, unspecified} OR score ≥ **50**; drop only internships/student/trainee; delete the big-company junior exception paragraph; keep stale->30d drop EXCEPT when flagged as repost (see §2). Report each job's seniority level in the WhatsApp line. Per-person: read thresholds from person config (`people/<id>/sources.json` new `scoring: {min_score, levels_acceptable}` block) so guests keep 70/senior-mid.

### 2. Repost resurfacing

- Capture `datePosted` per candidate wherever available: ATS APIs (`first_published`/`createdAt`/`publishedAt`/`releasedDate`), LinkedIn card listdate, JSON-LD `JobPosting.datePosted` fallback (Lever pages verified; use browser UA).
- Seen ledgers (`linkedin-seen.json`, `ats-seen.json`): migrate `seen_ids` array → map `{id: {first_seen, last_seen, date_posted?}}` (backward-compatible loader). An id whose fresh `datePosted` is meaningfully newer than `last_seen` is treated as NEW (repost) and re-enters the pipeline flagged `repost: true`.
- `tools/ledger.mjs` / Step 3a: a candidate matching the sent-suggestions ledger (content key) is NOT auto-dropped when `repost: true` or when its datePosted is newer than the ledger `date`. Instead it goes to Step 2/6 with context: last-sent date, applied? (from Sheet), repost date. LLM guideline: recommend re-apply when repost is ≥ ~3 weeks after last send/application, or clearly a fresh opening; judgment call, not hard rule. Presented under 🔁 with "שווה להגיש שוב" + the dates. Ledger entry updated (not duplicated) on resend.

### 3. Source expansion

New poll-tier providers in `tools/lib/ats.mjs` (all verified public JSON, no auth):
- **workday**: `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` body `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"Israel"}`. Seed: `intel/wd1/External` (has Petah Tikva), `nvidia/wd5/NVIDIAExternalCareerSite`. Date: `postedOn` fuzzy; exact date via per-job detail call when needed.
- **amazon**: `GET https://www.amazon.jobs/en/search.json?base_query=<kw>&loc_query=Israel` (`posted_date`).
- **smartrecruiters**: `GET https://api.smartrecruiters.com/v1/companies/{id}/postings` (`releasedDate`). Seed: `Wix2`.
- **lever-eu**: `https://api.eu.lever.co/v0/postings/{c}?mode=json`. Seed: `mobileye`.
- **drushim**: `GET https://www.drushim.co.il/api/jobs/search?searchterm=<kw>&ssaen=1` (posted date in `JobInfo`; paginate via `NextPageNumber`). Query with david's QA keywords.
- Keep existing comeet/greenhouse/lever/ashby/bamboohr/getro providers.
- `people/david/company-watchlist.json`: add the seeded entries above under their platforms.

Tavily discovery-tier revamp (`people/david/sources.json` `tavily.queries` + `tools/search.mjs` support for `include_domains`/`time_range` passthrough):
- Replace 3 queries with X-ray set using `include_domains` (single query can carry all ATS domains) + `time_range:"week"`: domains `comeet.com, job-boards.greenhouse.io, boards.greenhouse.io, jobs.lever.co, jobs.eu.lever.co, apply.workable.com, jobs.ashbyhq.com, careers.smartrecruiters.com, myworkdayjobs.com`; queries covering QA Automation / SDET / Test Automation + Israel/Tel Aviv/Petah Tikva.
- Weekly discovery job (piggyback on Saturday weekly-review): dork for NEW Israeli company slugs on these platforms; auto-append to `company-watchlist.json` (with a changelog note in the weekly report).
- Afternoon run continues to skip Tavily (quota).

### 4. One-time full backfill (run after implementation, same day)

One-off orchestrated run (person=david) with `mode=backfill`: all sources, widest windows (LinkedIn `--window-days 30`; ATS/Workday/etc list all currently-open matching roles regardless of age), seniority+score filters OFF, ledger dedup OFF (skip only Sheet rows marked applied within last 30 days), role+location filters ON. Output: all → Sheet (scored+sorted, seniority column), WhatsApp: summary counts + top-20 + sheet link. Seen-state and ledger updated at the end (next days = only new).

### 5. Daily interview question (new feature)

- New `skills/job-scout/prompt-daily-question.md`: pick a senior-QA-automation interview question (topic rotation: Selenium/Playwright/WebDriver internals, API testing, CI/CD, test architecture/frameworks, coding [JS/Python/Java], flaky tests, performance, mobile, SQL, general-senior behaviors), avoiding repeats via `data/learning/questions.jsonl`; send to David's group (question + "מושג היום" one new concept with short explanation); log entry; NO_REPLY discipline for anything else.
- Conversational path (prompt-qa.md router addition): when David replies to a question, evaluate as a strict-but-supportive interviewer — verdict, what was missing, model answer, follow-up tip; update `data/learning/progress.md` (weak topics, level calibration). Difficulty adapts over time.
- OpenClaw cron job: daily ~08:33 IL (offset from :30), message = run prompt-daily-question.md. Deliverable to David at the end: the first question (sent live) + the cron definition for feedback.

### 6. CV ATS audit (one-off deliverable)

Locate David's CV (people/david/ or workspace docs). Audit: text extraction fidelity (simulate ATS parsing: pdftotext), section headers, contact info, keyword coverage vs. target JDs (QA Automation/SDET), formatting hazards (tables/columns/graphics), file naming. Deliver a Hebrew report with concrete fixes; if trivial fixes possible in source doc, propose them.

## Non-goals

- No change to role scope (off-field filter), location lists, guests' policies, gateway config, or WhatsApp routing.
- No LinkedIn scraping changes beyond date capture (rate limits stay respected).

## Safety & verification

- `tools/self-edit.mjs snapshot` before edits; `verify` (unit tests + syntax + config parse) after; revert on fail.
- All tool testing with `--no-persist`; NEVER trigger a full scout in tests (it sends WhatsApp). The backfill run is the deliberate exception, coordinated with David.
- New providers get unit tests alongside existing `tools/**/*.test.mjs` conventions.
- Watch next 08:00 cron end-to-end after activation.

## Rollout order

1. Snapshot → policy relaxation (§1) → new providers (§3 poll tier) → Tavily revamp (§3) → repost logic (§2) → tests+verify.
2. Backfill run (§4) → send report.
3. Daily-question feature (§5) + cron → send first question + cron def.
4. CV audit (§6) → send report.
5. Update prompt-scout-person.md docs + memory checkpoint.
