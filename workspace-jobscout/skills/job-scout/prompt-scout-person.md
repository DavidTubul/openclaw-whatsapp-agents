# Daily Scout — Single-Person Pipeline (spawned per person by prompt-scout.md)

You run the **full daily job-scout pipeline for EXACTLY ONE person** `P`. The orchestrator
(`prompt-scout.md`) spawned you and injected `P`'s parameters + the run MODE in your task message.
Execute every step using your **exec/bash tool** and your own reasoning. Today's date: `date +%F`.

All paths are absolute. The OpenClaw CLI wrapper (handles Node version) is `~/open_claw/openclaw`.
Helper scripts must be run with Node.

## Injected parameters (read them from your task message)

The orchestrator passes: `P.id`, `P.name`, `P.e164` (may be empty), `P.capabilities.{sheet,gmail,telegram}`,
`P.job_detail_level` (may be absent → treat as normal), `GROUP_JID`, and `MODE` (`LIVE` or `DRY RUN`).
If any parameter is missing or you need to double-check, **re-read it yourself** — the person entry from
the people registry, the group JID from the central registry:
```bash
cat ~/open_claw/workspace-jobscout/.config/people.json          # P's entry
node ~/open_claw/shared/tools/group-id.mjs main                 # GROUP_JID (single source: shared/registry.json)
```
`GROUP_JID` is the ONE group all LIVE reports go to. Substitute `P.id`, `P.name`, and gate steps
on `P.capabilities.{sheet,gmail,telegram}` exactly as below. Guests (role `guest`) have all capabilities `false`.

First load `P`'s CV summary (the scoring criteria):
```bash
cat ~/open_claw/workspace-jobscout/people/<P.id>/profile/cv-summary.json
```
The tools read `P`'s `sources.json` / `allowed-locations.json` / state themselves via `--person <P.id>` — you never pass paths.

**🚧 SINGLE-PERSON DISCIPLINE (the #1 correctness rule):** You serve ONLY `P`. Every candidate, score, message line,
and ledger entry must be about `P` and NOTHING else. Build `P`'s candidate list ONLY from tools called with
`--person <P.id>` in THIS run. **Self-check before composing the message:** does EVERY job match `P`'s own field
(per `P`'s cv-summary)? A job outside `P`'s field means a tool returned noise — drop it. Your message must be
unmistakably and exclusively about `P`.

---

## ⚙️ MODE — LIVE vs DRY RUN (read this before running any step)

Your task message says `MODE: LIVE` or `MODE: DRY RUN`. **Default is LIVE** if unstated.

**LIVE (production, real send):** run every step below exactly as written. This sends `P` a real WhatsApp message
and advances `P`'s stateful ledgers.

**DRY RUN (test / no side effects — sends NOTHING, writes NO stateful ledger):** run the pipeline read-only:
- **Step 1** `search.mjs` — run as-is (stateless Tavily, no persisted state).
- **Steps 1a / 1b / 1b2** `linkedin.mjs` / `telegram.mjs` / `ats.mjs` — run **with `--no-persist`** appended (read-only:
  no seen-ledger write, no drops-log write, already-seen jobs are INCLUDED). Verified flag on all three tools.
- **Step 1c** (URL validation) — **SKIP.**
- **Step 2 / 2b** scoring + normalization — run as-is (pure reasoning, no writes).
- **Step 3a** ledger `check` — run as-is (read-only; only `add` writes).
- **Step 3b** Sheet dedup **READ** (`sheet.mjs read`) — **allowed for the owner** (read-only). But **zero Sheet writes.**
- **Step 4** (Sheet append) — **SKIP.**
- **Step 5 / 5b / 5c** (Gmail sync + enrich + manual-notes reconcile) — **SKIP ENTIRELY** (do not run `gmail-search.mjs`
  at all — it would advance `gmail-state.json`; and no Sheet writes).
- **Step 6** compose the message — run as-is (owner portfolio counts come from the allowed Step-3b Sheet read; there
  will be no "status updates today" block because Gmail/5c were skipped).
- **Step 6b** (Sheet sort) — **SKIP.**
- **Step 7** (send) — **REPLACED**: instead of `openclaw message send`, write the fully-composed Hebrew message to
  `~/open_claw/workspace-jobscout/data/tmp/dry-run-<P.id>-<date>.md` (`mkdir -p` the dir first). Send NOTHING.
- **Step 7b** (ledger `add`) — **SKIP.**
- **Step 8** log — write to **`data/tmp/`** instead of `data/runs/` (see Step 8).

In BOTH modes the run ends **silently** with exactly `NO_REPLY` (see Final output discipline).

---

## ⚡ Steps 1/1a/1b/1b2 run IN PARALLEL (2026-07-15 — speed; David's request)

The four fetch tools are independent CLIs — do NOT run them one-after-another. Launch them
concurrently in ONE bash call, each writing its JSON to a temp file, and `wait` for all:
```bash
cd ~/open_claw/workspace-jobscout/tools && mkdir -p ../data/tmp/fetch-$$ && D=../data/tmp/fetch-$$ && \
  node search.mjs --person <P.id> > $D/search.json 2> $D/search.err & \
  node linkedin.mjs --person <P.id> > $D/linkedin.json 2> $D/linkedin.err & \
  node telegram.mjs fetch --person <P.id> > $D/telegram.json 2> $D/telegram.err & \
  node ats.mjs --person <P.id> > $D/ats.json 2> $D/ats.err & \
  wait; echo "fetch done: $D"; wc -c $D/*.json
```
(DRY RUN: append `--no-persist` to the linkedin/telegram/ats commands, exactly as each step below
specifies. Skip the telegram line entirely when `P.capabilities.telegram == false`. A cron variant
that skips Tavily skips the search.mjs line.) Then read the four JSON files and treat each one
exactly per its step below (output shapes, error tolerance, merge rules all unchanged). If a file
holds `{"ok":false}` or is empty, apply that step's failure rule and continue.

## Step 1 — Search (Tavily — Israeli boards + Indeed/Glassdoor)

```bash
cd ~/open_claw/workspace-jobscout/tools && node search.mjs --person <P.id>
```
(Already ran in the parallel block above — just read `$D/search.json`; do not run it again.)
Outputs `{"ok":true,"count":N,"candidates":[{source,title,company,location,url,snippet,score,query}]}`. Candidates already passed `P`'s location filter. (LinkedIn is NOT fetched here — see Step 1a.)

## Step 1a — LinkedIn (free public guest endpoint)

```bash
cd ~/open_claw/workspace-jobscout/tools && node linkedin.mjs --person <P.id>          # LIVE
cd ~/open_claw/workspace-jobscout/tools && node linkedin.mjs --person <P.id> --no-persist   # DRY RUN
```
(Already ran in the ⚡ parallel block — just read `$D/linkedin.json`; do not run it again.)
Same output shape (`source:"linkedin"`). It pulls jobs from LinkedIn's public guest endpoint (no login/API key/payment), using `P`'s own `data/linkedin-seen.json` ledger (first run = backfill, later = incremental). **If `P` has no LinkedIn keywords (a guest), it returns `count:0` and skips — that is expected.** **Merge these candidates into `P`'s candidate list for THIS run.** These URLs are canonical and already closed-checked — **skip Step 1c for `source:"linkedin"`**.
If `{"ok":false}` or `count:0`: continue (LinkedIn is best-effort; the ledger self-heals next run).

## Step 1b — Telegram channel fetch (only if `P.capabilities.telegram`)

If `P.capabilities.telegram == false` (e.g. a guest), **skip this step entirely.** Otherwise:
```bash
cd ~/open_claw/workspace-jobscout/tools && node telegram.mjs fetch --person <P.id>          # LIVE
cd ~/open_claw/workspace-jobscout/tools && node telegram.mjs fetch --person <P.id> --no-persist   # DRY RUN
```
(Already ran in the ⚡ parallel block — just read `$D/telegram.json`; do not run it again.)
Outputs `{"ok":true,"count":N,"candidates":[{source:"telegram:<channel>",title:"",company:"",location,url,snippet,score,msg_id,date}]}`. These are free-text Hebrew posts: `title`/`company`/`location` are EMPTY — fill them in Step 2 from `snippet`. The `url` is the message permalink. **Merge into `P`'s candidate list for this run.**
If `{"ok":false,"error":...}`: skip Telegram and continue. If the error mentions `AUTH`/`session`/`expired`, add to `P`'s Step 6 report: `⚠️ צריך login מחדש לטלגרם (דורש dev session)`.

## Step 1b2 — Direct ATS career-page poll (the under-the-radar source)

```bash
cd ~/open_claw/workspace-jobscout/tools && node ats.mjs --person <P.id>          # LIVE
cd ~/open_claw/workspace-jobscout/tools && node ats.mjs --person <P.id> --no-persist   # DRY RUN
```
(Already ran in the ⚡ parallel block — just read `$D/ats.json`; do not run it again.)
Same output shape (`source:"ats:<platform>"`, e.g. `ats:comeet`, plus `updated` = the REAL posting timestamp). Polls every company on `P`'s `people/<P.id>/company-watchlist.json` directly via the platform's public JSON API (Comeet / Greenhouse / Lever / Ashby / BambooHR) — no auth, no quota, postings appear here **before (or without ever) reaching LinkedIn/boards**. First run = backfill, later = incremental via `P`'s `data/ats-seen.json`. **If `P` has no watchlist it returns `count:0` with `skipped:"no-watchlist"` — expected for a new guest.** Candidates already passed `P`'s title filter, a foreign-office guard (global companies' boards mix regions), and `P`'s location filter; trust the `updated` field for the Step-2 recency backstop. **Merge into `P`'s candidate list for THIS run.** These URLs are canonical career-page links — **skip Step 1c for `ats:*` sources**.
If `{"ok":false}` or `count:0`: continue (best-effort; per-company failures are already tolerated inside the tool).

## Step 1c — Validate non-LinkedIn job URLs (edge cases only) — **DRY RUN: SKIP**

`search.mjs` and `linkedin.mjs` already drop closed LinkedIn postings, so **skip validation for `source:"linkedin"`** (and for `ats:*` sources — career-page links are canonical). Only if a NON-LinkedIn candidate's link looks like a closed/expired board listing and you can cheaply check it, drop it; if a check times out, keep it and add `⚠️ לא ניתן לאמת קישור` to its `notes`. Telegram permalinks are never validated. **In DRY RUN, skip this step.**

## Step 2 — CV-match scoring (YOUR holistic reasoning, against `P`'s CV)

Judge each candidate's **fit for `P`** holistically against **`P`'s cv-summary** (the file you loaded above), the way an experienced recruiter would. Do NOT mechanically add/subtract points; weigh the whole picture and assign a calibrated score.

For EACH candidate output:
- `level`: senior | mid | junior | unknown — infer from the title AND the responsibilities in the snippet, not just keywords.
  - **Big-tech level codes are NOT automatically junior:** bands like `IC1`/`IC2`, `L3`–`L5`, `E3`+ (Microsoft / Google / Meta / Amazon style) are seniority-ladder codes, not the word "junior" — read the responsibilities to infer the real level. When the level is ambiguous AND the role is in-field, **KEEP it** (recall over precision — David triages himself).
- For `telegram:*` candidates only: first derive `title`, `company`, `location` by reading the Hebrew `snippet`. If no clear company, leave it blank rather than guessing. Then score.
- `score`: 0-100 overall fit. Calibrate so ~70+ = "clearly worth `P`'s time", ~85+ = "strong match, prioritize". The KEEP cutoff itself comes from P's scoring config (see KEEP rule) — do not hardcode 70.
- `reason`: 1-2 sentences **in Hebrew** naming the 1-2 most concrete match points (or the dealbreaker if low).

**Signals to weigh — driven by `P`'s cv-summary (guidance, not arithmetic):**
- **Strong positive:** role matches `P`'s `preferred_role_titles` and overlaps `P`'s skills/domain; level ∈ `P.levels_acceptable`. For an IC who led people before, leadership is a *plus* for senior IC roles — but does NOT make a management role a fit.
- **Strong negative (push score low / drop):** title in `P`'s `excluded_role_titles`; any of `P`'s `exclusion_signals` present; intern/student/trainee (always a drop); junior only if junior ∉ P's levels_acceptable; a sector in `P`'s `excluded_sectors`; a role clearly outside `P`'s field even if a keyword matched.
- **STALE POSTINGS — DROP (recency rule):** the scout surfaces only **recent** openings. If a candidate's snippet/title shows it was posted **more than ~30 days ago** (e.g. "Posted 6 months ago", "לפני שנה", "12 months ago", "פורסם לפני X חודשים", an old year like "2024/2025", a date clearly >30d back) → **DROP it**, regardless of fit. When the snippet gives NO posting date, keep it (the LinkedIn tool already time-windows to the last week). Never surface a job that is clearly months or a year old — David explicitly wants last-week postings. Exception: a candidate carrying `repost:true` (or one you qualified as a repost in Step 3a) is judged by its REPOST date, not its original posting date — a re-published old role is fresh.
- The authoritative exclusion lists live in `P`'s `cv-summary.json` (`excluded_role_titles`, `excluded_sectors`, `excluded_locations`, `exclusion_signals`) — apply them. (For David: IC QA/Automation only, no management titles, no defense/military employers. For a finance/analyst guest: analytical/financial roles only, no junior, no non-analytical roles.)
- Be honest on ambiguous cases — don't inflate.

**KEEP rule (per-person, from `P`'s `sources.json` → `scoring`):** read `scoring.min_score` and `scoring.levels_acceptable` from the `sources.json` you can `cat` at `~/open_claw/workspace-jobscout/people/<P.id>/sources.json`. KEEP a candidate if `level ∈ scoring.levels_acceptable` OR `score >= scoring.min_score`. If the person has NO `scoring` block, use the legacy defaults: `levels_acceptable = [senior, mid]`, `min_score = 70`. Drop the rest.
**David (2026-07-16 policy):** his block is `min_score: 60`, `push_min_score: 70`, `levels_acceptable: [senior, mid, junior, unknown]` — i.e. every seniority level from ANY company passes; there is no big-company condition anymore. KEEP (→ Sheet, Step 4) at `score >= 60`; only `score >= 70` is ALSO pushed to the WhatsApp report (see the Step 6 push threshold). Internships/student/trainee are ALWAYS dropped regardless of config (they are hard-filtered upstream too).

### Step 2b — Uniform presentation (normalize every kept candidate)

- **role (title):** clean canonical job title only — strip emojis, company, location, dates, marketing.
- **company:** clean name, no `בע"מ`/`Ltd`/`Inc`, no emojis.
- **location:** one canonical city (the matched allowed-city); remote → `Remote-IL`; unknown → blank (never guess).
- **reason:** Hebrew, 1–2 sentences, same format for all sources.

## Step 3 — Dedupe (ledger ALWAYS; Sheet only for the owner)

**3a. Ledger check (ALWAYS — read-only in both modes):** before any Sheet work, check candidates against `P`'s sent-history:
```bash
cd ~/open_claw/workspace-jobscout/tools && node ledger.mjs <P.id> check '[{"company":"<company>","role":"<role>"}, ...]'
```
Returns `{"already":[entries],"fresh":[items-with-id]}`. Each `already` entry is the original send record `{id,title,company,date,first_date?,...}`.

**Repost triage (2026-07-15 — David wants re-application chances):** **Repost triage is OWNER-ONLY (`P.capabilities.sheet == true`).** For a guest, EVERY `already` match is dropped as before — no resurfacing. For the owner: an `already` match is NOT an automatic drop. For each one, compare:
- `sent_date` = the ledger entry's `date` (last time it was sent), and Sheet status if owner (was it applied? rejected?).
- `posted_date` = the candidate's freshest posting signal: `posted` (LinkedIn), `updated` (ats:*), a date in the snippet, or `repost:true` flag from the ATS tool.
Decide like a recruiter when a re-application is worth it — there is no hard cutoff, but as guidance: the role was genuinely re-published (posted_date clearly after sent_date, or `repost:true`) AND enough time has passed since the last send/application (~3+ weeks) that a fresh submission looks intentional, not spammy. Rejections: a repost ≥ ~2 months after a rejection is fair game (teams and openings change); sooner — skip. If it qualifies → treat it as a `new_job` with `repost: true` (it flows through scoring, Sheet, and the ledger `add`, which refreshes its date). If not → keep it in the old `already` bucket for the 🔁 FYI section. When in doubt, surface it — David triages himself.

**3b. Sheet dedupe — ONLY if `P.capabilities.sheet`:**
If `P.capabilities.sheet == false` (a guest): SKIP all `sheet.mjs` calls. The ledger from 3a is `P`'s ONLY dedup set; every `fresh` candidate is a `new_job`. Jump to Step 6.

If `P.capabilities.sheet == true` (the owner): dedupe against the Sheet (by **company + role**, NOT URL). **The `sheet.mjs read` here is ALLOWED in DRY RUN (read-only); only the WRITE steps (4/5/6b) are skipped.**
```bash
cd ~/open_claw/workspace-jobscout/tools && node sheet.mjs read
```
Capture per row: `sheet_row, id (A), role (D), company (E), source (C), url (J), status (K)`.
- **Merge duplicates WITHIN this run:** cluster `fresh` candidates by (company + role) semantically. Collapse each cluster: `source` = distinct sources joined ` + `; primary `url` = best apply link (prefer a board/company URL over a Telegram permalink); secondary links → notes (`גם בטלגרם: <permalink>`); keep the highest `score`/`reason`.
- **Dedupe each canonical candidate vs existing rows.** Content id:
```bash
cd ~/open_claw/workspace-jobscout/tools && node jobkey.mjs "<company>" "<role>"
```
Match by (1) id == an existing row's `id`, or (2) semantic company+role match. Then:
  - **⭐ REPOST EXCEPTION (checked FIRST):** if the candidate carries `repost: true` (qualified in Step 3a), it is NEVER dropped or demoted to a source-merge here — even when it matches an existing row with no new source. It STAYS in `new_jobs`, but instead of appending a duplicate row in Step 4, update its EXISTING Sheet row **by its id** (LIVE): `node sheet.mjs update-by-id <id> '{"found_at":"<today>","status":"⏳ Pending","notes":"<existing notes> | פורסמה מחדש <DD/MM>"}'` — but if the row's current status is `📞 Interview` or `🎉 Offer`, KEEP that status (update only `found_at` + the note; an in-play application must not be reset to Pending). **DRY RUN: do NOT update — just note it would be a repost row-update.** Mark this candidate so Step 4 knows it was already updated-by-id and must NOT be appended again.
  - **Match + a NEW source not in that row's col C:** (LIVE) update the row **by its id** (add source + secondary link), do NOT resend: `node sheet.mjs update-by-id <id> '{"source":"<joined>","notes":"<existing + secondary>"}'`. **DRY RUN: do NOT update — just note it would be a source-merge, and drop it from new_jobs.** (Use `update-by-id`, NOT `update <sheet_row>`: the sheet re-sorts on every status change/append, so a captured row number goes stale after the first write in this run — the `id` is stable.)
  - **Match, no new source:** drop.
  - **No match:** it is a `new_job` (carry its content id).
If `jobkey.mjs` exits non-zero, fall back to semantic match. If `sheet.mjs read` fails, treat all `fresh` as new (log to stderr) — never crash.

## Step 3c — Link-quality gate (verify the final KEEP list) — MANDATORY before any Sheet write / send

Before writing to the Sheet (Step 4) or composing/sending the message (Steps 6–7), pipe the final
KEEP list (this run's `new_jobs`, including repost-qualified ones) through the link-quality gate and
DROP everything it rejects — a dead posting (404/410, redirect-to-homepage, Workable `/oops`, closed-
posting text), a non-URL in the `url` field, or a search/feed/junk page (glassdoor search, facebook,
linkedin `/jobs/search`, google search — specific job pages on jobhunt/alljobs/drushim are allowed):
```bash
cd ~/open_claw/workspace-jobscout/tools && \
  echo '[{"id":"<content id>","url":"<url>","title":"<role>","company":"<company>"}, ...]' \
  | node verify-links.mjs check --person <P.id>
```
It prints `{ok,results,drop,keep}`. **Remove every id in `drop` from `new_jobs`** so it is neither
appended to the Sheet (Step 4) nor shown in the message (Steps 6–7); the dropped items are logged to
`P`'s `drops.jsonl` (via `--person`). The gate **fails OPEN** on any link it can't verify (network
error / timeout / 403·429·999 bot-block / LinkedIn authwall) — a live link is never dropped by
mistake. LinkedIn (`source:"linkedin"`) and `ats:*` URLs are already canonical/closed-checked; passing
them through is harmless (they verify `ok`).

**DRY RUN:** run the check **WITHOUT `--person`** (no drop-log write), still removing dropped ids from
what *would* be written/sent.

**🔧 Link maintenance (owner + LIVE only) — once per daily run, AFTER the Step 7 send:** flag any
now-dead ⏳ Pending rows already in David's Sheet:
```bash
cd ~/open_claw/workspace-jobscout/tools && node verify-links.mjs maintenance
```
It re-checks every Pending row's url and appends a short Hebrew note (`🔗 הקישור כנראה פג — …`) to the
**notes column only** (never status/url; rows already carrying `🔗 הקישור` are skipped). Guests / DRY
RUN: skip entirely.

## Step 4 — Append new jobs to the Sheet (ONLY if `P.capabilities.sheet`) — **DRY RUN: SKIP**

Guests: skip — the ledger (Step 7b) is the record. **DRY RUN: skip (no Sheet writes).** Owner + LIVE: append all `new_jobs` in ONE call, content id from Step 3b, normalized fields. **Repost candidates (`repost: true`) were already updated-by-id in Step 3b — do NOT append them again; append only genuinely-new jobs (those with no matching existing row).**
```bash
cd ~/open_claw/workspace-jobscout/tools && node sheet.mjs append '[{"id":"<content id>","found_at":"<YYYY-MM-DD>","source":"<joined sources>","title":"<normalized role>","company":"<normalized company>","location":"<canonical location>","level":"<level>","score":<score>,"reason":"<hebrew reason>","url":"<primary url>","notes":"<secondary links or empty>","status":"⏳ Pending"}, ...]'
```
Confirm `appended` equals the number of new_jobs.

## Step 5 — Gmail status sync (ONLY if `P.capabilities.gmail`) — **DRY RUN: SKIP ENTIRELY**

Guests: skip entirely. **DRY RUN: skip entirely — do NOT run `gmail-search.mjs` (it advances `gmail-state.json`).** Owner + LIVE:
```bash
cd ~/open_claw/workspace-jobscout/tools && node gmail-search.mjs --person <P.id>
```
This is **incremental** — it only returns mail newer than the last run (state in `P`'s `data/gmail-state.json`); first run falls back to ~2 days. Returns `{from,from_name,subject,date,uid}`. Drop noise: LinkedIn job-alert/digest, newsletters, security notices.

### ⚠️ Subjects lie — classify from the BODY, not the subject

Recruiting platforms (Comeet, Spark Hire, Greenhouse, Lever, Workday, Jobvite) send **rejections whose subject reads like a confirmation**. The classic trap is **`Thank you for applying for the <role> position at <company>`** — almost always a **REJECTION**, despite the word "applying". Contrast the genuine confirmation **`We Got It: Thanks for applying for <role>`**.

Cheap first pass on the subject, but **whenever the subject is ambiguous, fetch the body** (see `keywords.json` → `ambiguous_subjects_read_body`):
- `Thank you for applying for the … position at …` · `Thanks for your recent interest in joining us at …`
- `Thank you from <company>` · `Update (on|regarding) your application` · `Important information about your application`
- `Your application at/to <company>` · `<Company> | David` (Lever) · any bare/opaque subject

Fetch the decoded body:
```bash
node gmail-search.mjs --uid <uid>     # returns {uid,from,subject,date,text}
```
Classify from `text`:
- **rejected**: "move forward with other/another candidate(s)", "decided not to proceed", "unfortunately", "we regret", "position filled / no longer open", Hebrew "לצערנו / החלטנו לא להמשיך / המשרה אוישה".
- **applied** (confirmation): "we received your application", "thank you for submitting your resume/CV", "we'll be in touch" — and NO rejection language.
- **interview**: schedules/confirms a call/interview/phone-screen, or a next step.
- **offer**: a formal offer.

Reliable **confirmations** (no body read): `We Got It: Thanks for applying …`, `Application received`, `We received your application`.

### Match to a row and update (newest email wins)

Match each classified email to a row by sender domain/company name (fuzzy).
- Update only if the new status **differs** from the current.
- **Most recent email wins** — never downgrade `📞 Interview`/`❌ Rejected` back to `✅ Applied` from an older email.
- **Re-applications:** `❌ Rejected` row + a NEWER application-confirmation → set back to `✅ Applied`, note prior rejection.
```bash
node sheet.mjs update-by-id <id> '{"status":"❌ Rejected","applied_at":"<YYYY-MM-DD>","notes":"סירוב — <date>","email_snippet":"<subject, first 100 chars>"}'
```
Use `update-by-id <id>` (from the row's col A captured in Step 4), NOT `update <sheet_row>`: each
status write re-sorts the sheet, so row numbers captured earlier in this run are stale. Verify each
write from the returned `row_after`. Track how many rows updated + each company+status (for Step 6).

### Step 5b — Enrich new "applied" rows for jobs the scout never recommended (owner only) — **DRY RUN: SKIP**

For any **applied** email, FIRST match to an existing row by **company + role**. If matched, update status only (do NOT append). Only if NO row matches, append a basic row (id from `jobkey.mjs "<company>" "<title>"`), then try to enrich (url/location/level/score/reason) via `openclaw infer web search`. If you can't find enough info → add the company to a `needs_info` list and ask **once** in Step 6 (David sends the link later; prompt-qa enriches it). **DRY RUN: skip (no Sheet writes).**

## Step 5c — Reconcile status from David's MANUAL notes (ONLY if `P.capabilities.sheet`) — **DRY RUN: SKIP**

Guests: skip. **DRY RUN: skip (no Sheet writes).** Owner + LIVE: David edits the Sheet by hand and **writes free-text comments about a job in
the notes column (col M)** — e.g. "דיברתי עם המגייסת, יש ראיון ביום ג'", "דחו אותי בטלפון", "קיבלתי
הצעה", "לא מעוניין, רחוק מדי". Read those comments and **update the status (col K) to match what he
wrote.** Run this AFTER Gmail sync so David's manual note is the freshest signal.

Re-read the Sheet (or reuse the read from Step 5), and for EACH row inspect col M (`notes`):

**1. Separate David's free-text from the bot's OWN machine-notes — and IGNORE the machine-notes.**
The bot writes these patterns into col M; they are NOT a status signal and must be skipped:
- `גם בטלגרם: <permalink>` / any bare URL (secondary links)
- `סירוב — <date>` (bot's own rejection marker)
- anything starting with `⚠️` (e.g. `⚠️ לא ניתן לאמת קישור`)
- `זוהה ממייל` and similar machine markers
Whatever **remains** is David's free-text comment. If nothing remains (empty, or machine-notes only) → **skip the row.**

**2. Read the comment HOLISTICALLY and infer the status it implies** — do NOT keyword-spot. Use its
**net / most-recent meaning**:
- 📞 `Interview` ← ראיון / זימנו אותי / יש לי שיחה / פגישה / מגייס.ת חזר.ה / next step.
- ❌ `Rejected` ← דחו / לצערנו / לא התקבלתי / נפסלתי — **as the comment's current outcome.**
- 🎉 `Offer` ← קיבלתי הצעה / offer.
- ✅ `Applied` ← הגשתי / שלחתי קו"ח / applied.
- ⛔ `Not Interested` ← an explicit pass (לא מעוניין / לא רלוונטי / מוותר) **OR a dealbreaker reason
  David is recording to drop the job** — in his Sheet these phrasings consistently mean "not pursuing":
  manual-testing-only (`ידני` / `בדיקות ידניות` / `רק ידני`), too far (`ירושלים רחוק` / `הרצליה רחוק`),
  closed/filled (`משרה שנסגרה` / `משרה אוישה` / `לא מקבלים מועמדים`), abroad (`חו"ל`), premium-only
  (`דורש מנוי פרימיום`), management title (`ראש צוות`), or a skill/experience mismatch he flags as a
  reason to skip (`שפה לא מעניינת`, `דורש 7+ שנים`).

**⚠️ Re-application trap — read the WHOLE note, the LATEST event wins.** A note that mentions a past
rejection but a newer re-application (e.g. `נדחה 23/03, הוגש מחדש 23/05 — ממתין`) means **`✅ Applied`
/ waiting — NOT `❌ Rejected`**. Never flip such a row to Rejected on the word "נדחה". Likewise
`ראיון ... ואז סירוב` → the latest event is the rejection → `❌ Rejected`.

Only act on a **clear** decision/outcome. Vague comments, reminders, or mid-process complaints
(`לבדוק מחר`, `חברה מעניינת`, `תהליך מייגע של מילוי שאלון`, `אולי כבר הגשתי...`) → **leave status as-is.**

**3. Conflict resolution — NEWEST WINS (David's manual note is the freshest signal):**
David just typed it, so a clear human statement **overrides** whatever status the scout/Gmail set.
- Apply the note-implied status when it differs from the current status.
- **Anti-downgrade guard:** do NOT let a *weaker* note pull a stronger, already-confirmed status
  backward. A note implying `✅ Applied` must NOT overwrite an existing `📞 Interview`/`🎉 Offer`.
  Apply the note only if it's a **forward step** (Pending→Applied→Interview→Offer) OR a **definitive
  terminal statement** (`❌ Rejected` / `⛔ Not Interested` / `🎉 Offer`) — those always win.

**4. Update ONLY col K (status) — NEVER overwrite col M.** David's comment stays intact:
```bash
cd ~/open_claw/workspace-jobscout/tools && node sheet.mjs update-by-id <id> '{"status":"<new status>"}'
```
Use `update-by-id <id>` (col A), NOT `update <sheet_row>` — earlier status writes in this run re-sorted
the sheet, so captured row numbers are stale; the id is stable. Update only when the implied status
**differs** from the current one (idempotent — no-op if equal).

**5. Track each change for the Step 6 report**, tagged as note-driven, e.g. `{company} — {new_status} (לפי ההערה שלך)`.

## Step 6 — Compose `P`'s WhatsApp message (Hebrew) — ALWAYS compose one

**Always compose a daily message for `P` — even with 0 new jobs** (then a short heartbeat).

**🔢 Ordering rule (both owner & guest):** list `new_jobs` **sorted by `score` descending** — the strongest match is #1, weakest last. Keep the numbering (1., 2., …) in that order. This way the most relevant job is always at the top of the message.

**🔔 Push threshold (OWNER only — 2026-07-16):** the Sheet keeps every KEEP'd job (Step 4), but the WhatsApp report shows only the strong ones. Read `push_min_score` from `P`'s `sources.json` → `scoring` — **fallback: `push_min_score = min_score` when the key is absent, and the legacy `70` when there is no `scoring` block at all** (do NOT hardcode David's numbers). Include a `new_job` in the 🆕 list **only if its `score >= push_min_score`**; jobs scoring at/above `min_score` but below `push_min_score` were still appended to the Sheet in Step 4 but are **OMITTED** from the message (so `N` = the number actually shown, which may be 0). This split applies to the **owner only** — **guests show every KEEP'd job as before**. **Repost-qualified jobs (🔁) and the "appeared again" FYI section are NOT gated by this threshold** — keep that logic intact.

**If `P` is the OWNER (`P.capabilities.sheet == true`):** re-read the Sheet (`node sheet.mjs read` — allowed in DRY RUN) for accurate counts, then:

Always render the `@{P.e164 without leading +}` mention so this report is tagged to `P`; if `P` has no e164, OMIT the `@…` token but ALWAYS keep `בוקר טוב {P.name}!` as the unmistakable header. `P`'s message must be a self-contained block clearly owned by `P`.
```
@{P.e164 without leading +} 🔵 בוקר טוב {P.name}! — {DD/MM/YYYY}

📊 סטטוס תיק ההגשות:
✅ הגשת: {a} | 📞 ראיון: {i} | 🎉 הצעה: {o} | ❌ דחייה: {r} | ⏳ ממתין: {p}

{if status updates this run:}
🔔 עדכוני סטטוס היום:
  • {company} — {new_status}

{if new_jobs:}
🆕 {N} משרות חדשות התואמות אותך:
1. {title}  (score: {score})
   🏢 {company} · 📍 {location} · 🎚️ {level}
   💡 {reason}
   🔗 {url}

{if repost-qualified new_jobs exist, they appear in the 🆕 list above with a 🔁 prefix:}
🔁 {title}  (score: {score}) — פורסמה מחדש!
   🏢 {company} · 📍 {location} · 🎚️ {level}
   🕐 נשלחה אליך לראשונה ב-{first_date or date}, פורסמה מחדש ב-{posted_date} — שווה להגיש שוב
   💡 {reason}
   🔗 {url}

{if any already[] entries did NOT qualify for resurfacing — CAP AT 8 LINES: if more than 8, show the 8 most recent (by sent date) + one summary line:}
🔁 הופיעו שוב אבל עדיין מוקדם להגשה חוזרת:
  • {company} — {title}, נשלחה ב-{DD/MM} [לא נשלחה שוב]
  {if more than 8:}• +{N} נוספות (בגיליון)

{if needs_info not empty:}
❓ זיהיתי שהגשת בעצמך למשרות הבאות (לא המלצתי עליהן) ולא הצלחתי למצוא פרטים.
שלח לי כאן את הקישור לכל אחת ואשלים את הנתונים:
  • {company1}

📋 לטבלה המלאה: {sheet_url from people.json P.sheet.sheet_url}
```
(If 0 new jobs AND 0 status changes, still compose the portfolio block — it's the daily heartbeat.)

**If `P` is a GUEST (`P.capabilities.sheet == false`):** short message, jobs only (no portfolio/Sheet):
```
@{P.e164 without leading +} 🔵 בוקר טוב {P.name}! — {DD/MM/YYYY}

{if new_jobs:}
🆕 {N} משרות חדשות עבורך:
1. {title}  (score: {score})
   🏢 {company} · 📍 {location} · 🎚️ {level}
   💡 {reason}
   🔗 {url}

{if 0 new_jobs:}
אין משרות חדשות שתואמות אותך היום — אעדכן מחר 🤖
```

**If `P.job_detail_level == "full"` (currently only `uri`):** for each `new_job`, after the `💡 {reason}` line
add the job's full description + requirements, fetched via `openclaw infer web search`/`WebFetch` on the
job's `url` (LinkedIn/board postings render this in the page body — pull the "About the job"/requirements
section verbatim, trimmed of boilerplate like "Report this job"). Format:
```
1. {title}  (score: {score})
   🏢 {company} · 📍 {location} · 🎚️ {level}
   💡 {reason}
   📄 תיאור מלא ודרישות:
   {full description + requirements text, Hebrew or original language as posted}
   🔗 {url}
```
If the fetch fails or the page has no extractable description, fall back to the short `snippet` and add
`(לא הצלחתי לשלוף תיאור מלא — הנה מה שיש)`. This does NOT change dedup/scoring — only presentation, and
ONLY for people with this flag set.

## Step 6b — Sort the Sheet (ONLY if `P.capabilities.sheet`) — **DRY RUN: SKIP**

```bash
cd ~/open_claw/workspace-jobscout/tools && node sheet.mjs sort
```
Status priority: 🎉 Offer → ⏳ Pending → 📞 Interview → ✅ Applied → ⛔ Not Interested → ❌ Rejected, within each by found-date newest-first. If it fails, skip silently. **DRY RUN: skip.**

## Step 7 — Deliver `P`'s message

**LIVE — send to the shared WhatsApp group:**
```bash
~/open_claw/openclaw message send --channel whatsapp --target "$(node ~/open_claw/shared/tools/group-id.mjs main)" --message "<P's composed hebrew message>"
```
ALWAYS the shared group JID (resolved above) — never any other target. One message for `P`. Confirm a Message ID.

**DRY RUN — write the message to a file, send NOTHING:**
```bash
mkdir -p ~/open_claw/workspace-jobscout/data/tmp
cat > ~/open_claw/workspace-jobscout/data/tmp/dry-run-<P.id>-<date>.md <<'DRYEOF'
<P's fully-composed hebrew message, verbatim>
DRYEOF
```
Do NOT call `openclaw message send` in DRY RUN under any circumstance.

### Step 7b — Update `P`'s sent-suggestions ledger — **DRY RUN: SKIP**

After a successful LIVE send, record every `new_job` so it is never re-sent to `P`:
```bash
cd ~/open_claw/workspace-jobscout/tools && node ledger.mjs <P.id> add '[{"id":"<content id>","url":"<url>","title":"<title>","company":"<company>","date":"<YYYY-MM-DD>"}, ...]'
```
If 0 new_jobs this run, skip this step. **DRY RUN: skip entirely (no ledger write).**

## Step 8 — Log (this person)

**LIVE:**
```bash
mkdir -p ~/open_claw/workspace-jobscout/data/runs
echo '{"date":"<iso>","person":"<P.id>","candidates":<n>,"kept":<n>,"new":<n>,"gmail_updates":<n>,"sent":true}' > ~/open_claw/workspace-jobscout/data/runs/<YYYY-MM-DD>-<P.id>.json
```
**DRY RUN (write to data/tmp/ instead, and `sent:false`):**
```bash
mkdir -p ~/open_claw/workspace-jobscout/data/tmp
echo '{"date":"<iso>","person":"<P.id>","mode":"dry-run","candidates":<n>,"kept":<n>,"new":<n>,"gmail_updates":0,"sent":false,"dry_run_report":"data/tmp/dry-run-<P.id>-<date>.md"}' > ~/open_claw/workspace-jobscout/data/tmp/<YYYY-MM-DD>-<P.id>.json
```

**Drop audit:** the LinkedIn + Telegram tools already record every candidate they dropped this run — with the reason (off-field / junior / management / location / closed / manual-only) — to `~/open_claw/workspace-jobscout/people/<P.id>/data/drops.jsonl` (one JSON line each; **skipped under `--no-persist`, so a DRY RUN writes none**). You don't write it; it's there for the weekly review and for chat Q&A like "why didn't I see job X?" — grep that file to answer honestly instead of guessing.

---

## ⚠️ Final output discipline — DO NOT narrate the run (applies to BOTH modes)

You are a spawned sub-agent. **EVERY turn you produce — not only your literal last one — becomes an
announce back to the orchestrator's chat channel, and that announce is delivery-bound: it can be sent
straight to the WhatsApp group.** This pipeline runs across many steps and tool calls, i.e. many separate
turns (Step 1 fetch, Step 2 scoring, Step 6 compose, Step 7 send, Step 8 log, …) — the leak is NOT limited
to your final reply. The ONLY user-facing message in this whole run is the LIVE Step 7 send you make via
`openclaw message send` (or, in DRY RUN, the file you wrote — which sends nothing).

- **On every single turn, your visible assistant text must be EMPTY — zero prose — except tool calls.**
  Do not think out loud between steps, do not explain what you're about to do or just did (e.g. "Message
  sent successfully, now logging Step 8", "Zero surviving candidates so this is a heartbeat run",
  "now running the link-maintenance check"). That is internal pipeline chatter, and on this session it is
  not invisible — it gets delivered to David's group as an unwanted (often English) message, every time it
  happens, not just once at the end.
- **Do NOT** write a closing summary, recap, or status narration (e.g. "Scout complete for David…") either.
- Per-person run facts belong **only** in the Step 8 log file and stderr — never in ANY assistant reply.
- End the run **silently**: your final turn output must be exactly `NO_REPLY` — the OpenClaw sentinel that
  suppresses the announce. Never Hebrew/English prose, never a summary, never a bare `.` — on every turn,
  not only the last one.
