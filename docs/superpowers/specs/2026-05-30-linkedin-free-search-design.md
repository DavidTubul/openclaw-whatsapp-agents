# LinkedIn job discovery via the free public guest endpoint

**Date:** 2026-05-30
**Status:** Approved (design) — pending spec review
**Author:** Scotty dev session

## Problem

David misses many relevant LinkedIn jobs. The scout currently discovers LinkedIn
postings **only** through Tavily web search (`site:linkedin.com/jobs` queries with
`time_range: "day"`). This is structurally weak:

- Tavily indexes static web pages; LinkedIn job pages render dynamically and are
  indexed sparsely and late, so most postings never surface.
- The personalized feed David sees (`linkedin.com/jobs/collections/recommended`)
  is auth-gated and account-specific — Tavily can never reach it.

## Constraint (hard)

**Everything must run on free platforms — no paid subscriptions, no API keys that
require payment to obtain this job data.** Verified the chosen approach satisfies this.

## Key finding (verified live from the server, 2026-05-30)

LinkedIn exposes a **public guest endpoint** that requires **no auth, no account,
no API key, no payment**:

```
https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=<kw>&location=<loc>&f_TPR=<window>&start=<offset>
```

A plain `curl` returned HTTP 200 with ~10 real, current job cards per page, cleanly
parseable into **title · company · location (incl. district) · job-posting id**:

```
[4418561672] Automation Team Lead, Israel | AlgoSec      | Petah Tikva, Center District, Israel
[4418983486] QA Automation Team Leader     | SolarEdge    | Herzliya, Tel Aviv District, Israel
[4418662933] Mid/Senior QA Engineer        | Qualitest    | Rosh HaAyin, Center District, Israel
```

This is far more comprehensive and current than the Tavily `site:` approach, and it
removes a (metered) Tavily dependency rather than adding one.

## Design decisions (confirmed with David)

| Decision | Choice |
|---|---|
| Integration | New dedicated tool `linkedin.mjs`; **remove** the weak `site:linkedin.com` Tavily queries. |
| Run modes | **First run = full backfill** (30-day window, deep pagination over ALL matching open jobs). **Subsequent runs = incremental** (adaptive window, early-stop, only genuinely-new jobs). |
| Time window | Backfill: **30 days** (`f_TPR=r2592000`). Incremental: **adaptive** = `(days since last successful run + 1) × 86400` seconds, capped at 30 days. A normal daily run → ~2 days; after a multi-day outage it auto-widens to cover the gap, then closes back down. |
| Efficiency | A `linkedin-seen.json` state ledger of all seen job-ids lets incremental runs early-stop pagination and emit only new jobs — no full re-scan daily. |
| Location filter | **Center only + Remote-IL** — reuse the existing `evaluateLocation` (allowed-locations.json). |
| Tavily (boards) | **Keep as-is** on the free tier for Israeli boards (alljobs/drushim/jobmaster) + Indeed/Glassdoor. Out of scope here. |

## Architecture

New tool: `workspace/tools/linkedin.mjs`. Single clear purpose: fetch + parse +
location-filter + dedup + closed-check LinkedIn jobs, print JSON in the **exact same
shape** as `search.mjs` so the existing pipeline (scoring → dedup → sheet → WhatsApp)
consumes it with zero downstream changes.

Output contract (identical to `search.mjs`):
```json
{"ok":true,"count":N,"candidates":[
  {"source":"linkedin","title":"...","company":"...","location":"...","url":"https://www.linkedin.com/jobs/view/<id>","snippet":"...","score":0,"query":"<keyword>"}
]}
```
On total failure it still prints `{"ok":true,"count":0,"candidates":[]}` (or
`{"ok":false,"error":...}` only on a config/parse error) so the scout never crashes.

### Components within `linkedin.mjs`

1. **Config load** — read keyword list from `sources.json` (new `linkedin` block), and
   `allowed-locations.json`, using the same `readFirstExisting` dual-path pattern as
   `search.mjs` (workspace path + installed-skill path).
2. **Fetch** — for each keyword, page through the guest endpoint with a browser
   User-Agent and a per-request timeout (~15s). The endpoint returns a variable number
   of cards per page (observed ~10), so advance `start` by the **number of cards
   actually parsed in the previous page** (not a fixed step) to avoid gaps/overlaps.
   Window (`f_TPR`) and stop conditions depend on the run mode (see "Run modes" below).
   ~300ms delay between requests.
3. **Parse** — extract per card: job-posting id (`urn:li:jobPosting:<id>`), title
   (`base-search-card__title`), company (`base-search-card__subtitle`), location
   (`job-search-card__location`). Unescape HTML entities, strip tags/whitespace.
4. **Location filter** — build `"<title> <company> <location>"`, run the shared
   `evaluateLocation` → keep center/Tel-Aviv-district/Remote-IL, drop the rest.
5. **Dedup** — within the run, by job-posting id and by normalized URL; and across runs
   via the `seen_ids` ledger (see "Run modes & state ledger" below).
6. **Closed-posting check** — parallel GET (same logic as
   `search.mjs::checkLinkedInOpen`), drop postings with "No longer accepting" /
   "משרה זו אינה מקבלת" / "not accepting applications". **Fails open** on timeout/error.
7. **Emit** — canonical URL `https://www.linkedin.com/jobs/view/<id>`,
   `snippet = "<title> at <company> — <location> (LinkedIn)"`, `score: 0` (the LLM
   scores in Step 2), `query` = the keyword that found it.

### Run modes & state ledger

State file: `workspace/data/linkedin-seen.json` —
`{"backfilled": bool, "last_run": "<YYYY-MM-DD>", "seen_ids": ["<jobid>", ...]}`.

- **Backfill (first run / `backfilled` not true):** `f_TPR=r2592000` (30 days), paginate
  each keyword deep until exhausted or a generous cap (~250 jobs / ~25 pages per keyword).
  Scan ALL currently-open matching jobs. Record every seen job-id. Set `backfilled:true`
  and `last_run`. This is the one expensive run.
- **Incremental (`backfilled` true):** **adaptive window** —
  `f_TPR = min(30 days, (today − last_run + 1 day))` in seconds, so the window exactly
  covers the gap since the last successful run (≈2 days normally, wider after an outage).
  Shallow paging with **early-stop**: stop a keyword once a full page contains no new ids
  (all already in `seen_ids`). Emit only candidates whose id is NOT in `seen_ids`; append
  the newly seen ids and update `last_run`. (`last_run` is the wall-clock date passed in
  by the caller, since `Date.now()` is fine in a standalone Node tool — only workflow
  scripts forbid it.)

The ledger tracks **every** id the tool has seen — including jobs that were later dropped
by location filter or low CV score — so the same posting is never re-fetched-and-
re-scored on later runs. The Sheet's company+role dedup (pipeline Step 3) remains the
downstream safety net against duplicate rows. The ledger is pruned to the most recent
~5000 ids to stay small.

Manual reset (re-trigger a full backfill): delete `linkedin-seen.json` or set
`backfilled:false`.

### Shared closed-check

`checkLinkedInOpen` currently lives privately inside `search.mjs`. To avoid duplication,
extract it into `workspace/tools/lib/linkedin.mjs` and import it from **both**
`search.mjs` and the new `linkedin.mjs`. (Targeted, in-scope improvement — both tools
genuinely need it.)

## Search parameters

- **keywords** (in `sources.json` → `linkedin.keywords`, editable, not hardcoded) —
  chosen to cover **Team Lead + Senior + Mid** explicitly:
  - Team Lead: `QA Automation Team Lead`, `QA Team Lead`, `Automation Team Lead`
  - Senior: `Senior QA Engineer`, `Senior Automation Engineer`
  - Mid / general: `QA Automation`, `Automation Engineer`, `SDET`, `Test Automation`,
    `QA Engineer`
- **location** = `Israel` (district filtering done locally by `evaluateLocation`, which
  already handles "Tel Aviv District" → Tel Aviv, blocks Petah Tikva/Haifa/etc).
- **f_TPR** = `r604800` (7 days).
- **pagination** = advance `start` by the number of cards parsed per page; early-stop on
  an empty page; per-keyword cap ~100 jobs (max ~10 pages) for incremental, ~250 for backfill.

### Seniority / level — Team Lead + Senior + Mid, NO junior-from-zero

David has real experience and explicitly wants **Team Lead, Senior, and Mid** roles —
**not** junior/entry/intern. Two-layer enforcement, coverage-first:

1. **Keywords** bias toward the wanted levels (Team Lead / Senior / Mid terms above).
2. **CV-match scoring (pipeline Step 2)** is the real guard: it already infers `level`
   from title + responsibilities and treats junior/intern/entry as a strong-negative /
   drop. This is where a mistagged or keyword-matched junior posting gets cut.

**Decision: do NOT hard-filter by LinkedIn's source-level param (`f_E`) by default.**
Posters tag seniority inconsistently, so an `f_E` source filter would silently drop good
mid/senior jobs that are mistagged or untagged — and David's #1 pain is *missed* jobs.
We maximize coverage at the source and let the LLM scorer drop the genuine juniors.
(`f_E=3,4,5` = Associate/Mid-Senior/Director remains an available opt-in lever in
`sources.json` if noise ever becomes a problem.)

## Pipeline integration

1. `prompt-scout.md` Step 1 → add `cd .../tools && node linkedin.mjs`, and **merge** its
   candidates into the same list as the Tavily candidates before scoring (Step 2),
   exactly like the Telegram merge in Step 1b.
2. `search.mjs` → remove the `LINKEDIN_KEYWORDS` array and the appended
   `site:linkedin.com/jobs` queries. The existing LinkedIn closed-check block in
   `search.mjs` becomes dead (no LinkedIn URLs from Tavily anymore) but is harmless;
   it now lives in the shared lib and is exercised by `linkedin.mjs`.
3. `sources.json` → remove the `site:linkedin.com` Tavily query; add the `linkedin`
   block with the keyword list.

## Error handling & resilience

- Per-request failure (429, timeout, network) → log to stderr, skip that page, continue.
- LinkedIn blocks entirely → tool returns `{ok:true,count:0}`; scout proceeds with
  Tavily + Telegram sources unaffected.
- Config/parse error → `{ok:false,error}` and non-zero exit (matches `search.mjs`).
- Never throws uncaught; `main().catch(...)` guard like `search.mjs`.

## Testing / verification

- `node linkedin.mjs` → `ok:true`, `count > 0`, all candidates center/Remote-IL.
- Manual filter assertions: a Petah Tikva / Haifa / Rosh HaAyin card is dropped; a
  Tel Aviv / Ramat Gan / Modi'in card is kept.
- A known-closed job id is dropped by the closed-check; an open one is kept.
- **Levels:** Team Lead / Senior / Mid postings surface; a clearly junior/entry/intern
  posting is dropped by the Step 2 scorer (spot-check a few scored candidates).
- **Adaptive window:** with `last_run` = yesterday, the computed `f_TPR` ≈ 2 days; with
  `last_run` = 6 days ago, it widens to ~7 days (capped at 30).
- End-to-end: run the scout pipeline, confirm LinkedIn candidates reach scoring and
  (if new) the Sheet + WhatsApp report, and that no `site:linkedin.com` Tavily query
  runs anymore.
- **Run modes:** with no `linkedin-seen.json`, first run does the 30-day backfill and
  writes `backfilled:true` + a populated `seen_ids`. Immediately running again returns
  ~0 new candidates (everything already seen) and early-stops — proving incremental
  efficiency. A brand-new posting appears on the next incremental run.

## Out of scope (YAGNI)

- Replacing Tavily for the Israeli boards (David chose to keep it on the free tier).
- Accessing the personalized `recommended` feed (requires David's login — not free/clean).
- Persisting LinkedIn results separately; the existing `sent-suggestions.json` +
  Sheet dedup already cover repeat-suppression.

## Notes / risks

- The guest endpoint is undocumented and could change its HTML structure or rate-limit.
  Mitigation: fail-open per request + `count:0` fallback keep the scout alive; parsing
  is class-name based and easy to re-fix if LinkedIn changes markup.
- This repo is **not** a git repository, so the design doc is saved but not committed.
