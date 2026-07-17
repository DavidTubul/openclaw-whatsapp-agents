# Scotty (סקוטי) 🤖 — Job-Search Assistant (read this first)

> Dev map for this agent's workspace. For the repo-wide picture of all agents, see
> `../CLAUDE.md`. Last reviewed: 2026-06-29.

> ⚠️ **Dev note.** OpenClaw injects ONLY the 6 persona files (**AGENTS/SOUL/IDENTITY/USER/TOOLS/HEARTBEAT.md**)
> into the bot's system prompt — never this `CLAUDE.md` or `SKILL.md`/`prompt-*.md` (on-demand only). So **always-on
> rules belong in `AGENTS.md`** (this file is a dev map for humans / dev sessions). Full explanation → `../CLAUDE.md`.

## What this is

**OpenClaw** is a self-hosted personal AI agent runtime. This workspace's persona is **Scotty (סקוטי) 🤖**,
a **multi-tenant job-search assistant**. It serves an **owner (David Tubul)** plus optional **guests**
(e.g. אורח), all from one shared WhatsApp group **"Job Scout 🤖"**. Everything here serves that job.

**Tenancy model (multi-person, upgraded 2026-05-30):**
- **Owner** (David): full pipeline — search + push + **Google Sheet tracking** + **Gmail status sync** + Telegram.
- **Guest** (e.g. אורח): search + push + **light Q&A only**. NO Sheet, NO Gmail, NO Telegram. Their only
  dedup memory is the per-person ledger (`tools/ledger.mjs`).
- Each person has their own CV, search sources, location filter, and `data/` under `workspace-jobscout/people/<id>/`.
- The registry `workspace-jobscout/.config/people.json` defines who exists and what each can do (capabilities gate the tools).

Scotty does, **per enabled person**:
1. **Twice-daily scout (Asia/Jerusalem, 2 crons)** — searches LinkedIn + Israeli boards (alljobs, drushim, jobmaster) + Indeed/Glassdoor via Tavily + (owner-only) a Telegram channel (IL_QA_Job) + direct ATS poll (Step 1b2), matched against that person's CV. Scout **loops over enabled people**.
   - **08:00 FULL** — `job-scout-daily`, id `5d7587f3-…`. Runs the whole prompt-scout.md pipeline incl. Step 1 (`search.mjs`/Tavily).
   - **15:00 afternoon** — `job-scout-afternoon`, id `ef7fd460-…` (added 2026-07-01). Same pipeline, same target/model (sonnet-5/high), with the **ONE difference that it skips Step 1 (`search.mjs`/Tavily)** to protect the free ~1000/mo Tavily quota (quota overrun = the end-of-month "no jobs"). **Everything else runs normally:** Step 1a LinkedIn, 1b Telegram, 1b2 ATS, and — for the owner (david) per `capabilities` — **Step 3b/4 Sheet dedupe+append, Step 5 Gmail status-sync, 5b/5c reconcile** (Gmail + Sheet get updated in the afternoon too, not just the morning).
   - Ledger dedupe means the afternoon surfaces only genuinely-new jobs since the morning; heartbeat if 0.
   - ⚠️ **Cron payloads ENUMERATE their steps.** The Tavily-skip (and every step that DOES run) is set by the cron **message payload**, not a prompt-scout.md flag — so a new/changed scout step won't run until the payload is updated, and if the payload doesn't list Steps 4/5/5b/5c the agent skips Gmail/Sheet. Cron edit = infra, needs David's approval. (Payload version history → `docs/HISTORY.md`.)
2. **CV match:** scores each job against that person's CV summary (the LLM itself does the matching reasoning).
3. **Push new jobs** to the shared WhatsApp group (Hebrew, clickable source URLs). **Always sends each enabled person a daily message** — a short heartbeat when 0 new (replaces the old "0 new → send nothing" rule).
4. **Track applications** (owner-only) in a **Google Sheet** via an Apps Script webhook.
5. **Sync status from Gmail** (owner-only, read-only, **incremental**): detects applied / interview / rejected / offer emails and updates the sheet.
6. **Reconcile status from David's manual notes** (owner-only, scout Step 5c, runs after Gmail): David hand-writes free-text comments in the Sheet's notes column (M) — e.g. "דחו אותי", "יש ראיון ביום ג'", "לא מעוניין". Scotty reads only **David's** free-text (ignoring its own machine-notes: `גם בטלגרם:`/bare URLs/`סירוב — <date>`/`⚠️…`/`זוהה ממייל`), infers the implied status, and updates col K — **newest-wins** (his manual note is the freshest signal and overrides scout/Gmail, with an anti-downgrade guard so a weak note can't pull a confirmed 📞/🎉 backward), **never overwriting the note itself**. Also on-demand in Q&A: "תעדכן סטטוסים לפי ההערות".

It also answers conversationally in WhatsApp ("לאיזה משרות הגשתי?", `/status`, `/list`, etc.), resolving the
sender first (owner / known guest / unknown) and serving each appropriately.

## Layout

```
workspace-jobscout/                        # Scotty's "home" — its memory & identity live here
├── IDENTITY.md                   # who Scotty is (Hebrew persona)
├── SOUL.md / AGENTS.md           # behavior rules, heartbeat/memory conventions (AUTO-LOADED into bot)
├── USER.md                       # about David (currently mostly empty — fill over time)
├── .config/
│   ├── people.json               # 👥 PERSON REGISTRY: shared.{default_person} + people[] (owner/guest, capabilities, match_e164). WhatsApp group id now lives in shared/registry.json, not here
│   └── job-scout.json            # ⚙️ DOMAIN config only: sheet id/webhook, google/tavily/timezone. WhatsApp wiring + session-hygiene moved to shared/registry.json (registry-v2 refactor)
├── people/<id>/                  # 👤 PER-PERSON home (e.g. david, yossi)
│   ├── profile/{cv.pdf,cv-summary.json,profile.md}   # that person's CV + search prefs
│   ├── sources.json              # their LinkedIn URL template + Tavily queries
│   ├── company-watchlist.json    # companies whose ATS career pages ats.mjs polls directly (david: 58, evidence-seeded)
│   ├── allowed-locations.json    # their city allow/block filter
│   └── data/                     # sent-suggestions.json, telegram-state.json, gmail-state.json, linkedin-seen.json, ats-seen.json
├── skills/job-scout/             # THE skill — see below
├── tools/                        # real executables the skill shells out to
│   ├── lib/people.mjs            # registry resolver: resolvePerson, listEnabled, personByE164
│   ├── ledger.mjs                # per-person sent-jobs dedup: `ledger.mjs <person> <check|add>` (only dedup memory for guests)
│   ├── sheet.mjs                 # Google Sheet webhook CLI (ping|append|read|update|update-by-id|find|ids|sort) — owner-only. PREFER update-by-id: writes are id-addressed (col A), immune to the auto-re-sort that scrambles row numbers.
│   ├── jobkey.mjs                # content dedup key: sha256(company|role)[:12]
│   ├── self-edit.mjs             # 🛡️ self-extension safety harness: snapshot|verify|revert|log|changelog — deterministic backup/test/auto-revert so chat-driven self-edits (prompt-self-extend.md) can't silently break the cron. verify runs the unit suite + syntax-checks every tool .mjs + validates guarded config JSON. SELF_EDIT_DIR env isolates the audit trail (tests use it).
│   ├── search.mjs                # Tavily job search (Israeli boards + Indeed/Glassdoor) — takes --person <id>
│   ├── linkedin.mjs              # LinkedIn FREE guest-endpoint search (no auth) — takes --person <id>; backfill→incremental via people/<id>/data/linkedin-seen.json; helpers in lib/linkedin.mjs
│   ├── ats.mjs                   # 🆕 direct ATS career-page poll (Comeet/Greenhouse/Lever/Ashby/BambooHR public JSON + Getro VC-board sitemaps, no auth/quota) — takes --person <id>; polls people/<id>/company-watchlist.json; backfill→incremental via people/<id>/data/ats-seen.json; pure logic in lib/ats.mjs
│   ├── gmail-search.mjs          # Gmail read-only search — --person <id>, INCREMENTAL (gmail-state.json + --after-uid); owner-only
│   ├── telegram.mjs              # Telegram channel fetch (gramjs/MTProto) — takes --person <id>; owner-only
│   ├── apps-script-webhook.gs    # the Apps Script deployed behind the sheet webhook
│   └── session-hygiene.mjs       # thin shim → shared/lib/session-hygiene.mjs (agentId "main"); params from shared/registry.json
│                                 # gateway hooks are SHARED — shared/hooks/{ack-react,chat-log,group-reply-policy}/
│                                 # resolve "main" by group via the registry (the old tools/hooks/ copies were deleted 2026-06-26)
└── data/
    ├── runs/YYYY-MM-DD.json      # per-day run summary (candidates/kept/new/sent)
    └── last-inbound.json         # {e164,fromMe,person,ts} of the last inbound — Q&A sender resolution
```

> Note: David was migrated from the old single-user layout into `people/david/` (2026-05-30 cleanup); per-person paths under `people/<id>/` are now the only source of truth (migration detail → `docs/HISTORY.md`).

## The job-scout skill (`workspace-jobscout/skills/job-scout/`)

- `SKILL.md` — entry point, mode routing, **hard rules** (see below), tool table.
- `prompt-scout.md` — the daily pipeline (run on `scout` / `/scout`); **loops over enabled people**, gates Sheet/Gmail by `capabilities`, always runs the ledger pre-filter, and always sends each person a daily message (heartbeat when 0 new). **Final-output discipline (2026-06-07):** in the cron scout session openclaw delivers the agent's final turn text to the group as a message, so a closing recap leaks (David was getting an English "Daily scout complete…" summary every night). The prompt now mandates the run **end silently** (empty final output) — the only user-facing messages are the per-person Hebrew reports sent in Step 7; run facts go to the Step 8 log only.
- `prompt-qa.md` — conversational Q&A mode (any free-form WhatsApp text); **Step 0 resolves the sender** (owner via `fromMe` / known guest by e164 / unknown = safe public persona) from `data/last-inbound.json`. Owner-only admin commands: `/people`, `/disable <id>`, `/enable <id>`, hard-delete-with-confirmation manage the registry.
- `prompt-weekly-review.md` — **self-improvement loop** (run on `weekly-review` / `/weekly-review`, owner-only). Reads the Sheet via `tools/weekly-review.mjs` (outcome funnel: per-source/level/score-band engagement vs. noise rate), distils lessons into `data/lessons/lessons-YYYY-WW.md`, and **proposes** (never auto-applies) criteria tuning to David in WhatsApp. Approval-gated by hard rule #8: David replies "כן תחיל" → a later Q&A turn applies the `PROPOSED CHANGES` JSON block from the newest lessons file to `people/david/sources.json` / `cv-summary.json`. Cron `job-scout-weekly-review` (id `551bdb61-…`), Sat 22:00 Asia/Jerusalem, sonnet-5/high.
- `prompt-self-extend.md` — **chat-driven self-extension** (added 2026-06-08; owner-only). The mechanism behind hard rule #8: David can evolve Scotty *from WhatsApp* without a dev session. SKILL.md mode-routing #3 loads it when the owner asks to change behavior / add a feature / fix something / do something not currently supported. Three paths: **A. one-off** (do it now with existing tools, no file edit, no approval — e.g. an ad-hoc deep scan via the LinkedIn guest endpoint with a custom `f_TPR` window, read-only so it doesn't corrupt ledger/Sheet); **B. permanent feature** (plan → David's explicit "כן" → safe-edit loop); **C. infrastructure** (secrets/OAuth/gateway/hooks/channels/cron → REFUSE, needs dev session). The Path-B safe-edit loop is **snapshot → edit → verify → revert-on-fail → log**, all via the deterministic `tools/self-edit.mjs` harness so a bad self-edit can never silently break the 08:00 cron. Auditable: "מה שינית?" → `self-edit.mjs changelog`.
- `router.md` — intent table: command prefixes (`/status`, `/list`, `/delete N`) + Hebrew NL regexes + status word map + row-number convention (**user job # = sheet row − 1**, header is row 1) + self-extend triggers ("תוסיף/תתקן/תתאים לעצמך", "מה שינית?").
- `sources.json` / `allowed-locations.json` — **per-person** under `workspace-jobscout/people/<id>/` (LinkedIn URL template + Tavily queries; city allow/block lists — center-Israel allow, Jerusalem/Haifa/PT/etc blocked; Remote-IL OK, Remote-global blocked). (The legacy copies under `skills/job-scout/` were deleted 2026-05-30.)
- `keywords.json` — email classification regexes (applied/interview/rejected/offer + noise) — owner Gmail sync only.
- CV-matching and per-source how-to are documented **inline** in `prompt-scout.md` (Step 2 = holistic per-person CV match; Steps 1–1c = each source). The old `skills/job-scout/tools/*.md` how-to docs were deleted 2026-05-30 (orphaned + single-user-stale).

### Under-the-radar sources — direct ATS poll (durable rules)
`tools/ats.mjs` + `tools/lib/ats.mjs` = scout **Step 1b2**. Polls each person's `people/<id>/company-watchlist.json` — Comeet / Greenhouse / Lever / Ashby / BambooHR public JSON + Getro VC-board sitemaps, **no auth, no quota**; state in `people/<id>/data/ats-seen.json` (incl. cached Comeet UID+token, re-scraped on failure). Guards beyond the shared location filter: **`foreignLocation()`** foreign-office drop (the shared filter is **fail-open on unknown cities** so global boards flood without it), a **manual-title drop** (title-level — ATS JDs are NOT fetched), and a **30-day zombie-posting window** (`--window-days` overrides; missing stamps pass). Tavily board queries were near-useless (funnel: 4/205 sheet rows) and were reworked to **~19/day ≈ 570/mo** across all people to stay under the free **1000/mo** quota (quota overrun = the end-of-month "no jobs"). ⚠️ Step 1b2 runs in the 15:00 cron only because its payload was updated to list it (see the cron-payload gotcha in duty #1). (Full investigation → `docs/HISTORY.md`.)

### LinkedIn search (durable rules)
In `tools/lib/linkedin.mjs` + `tools/linkedin.mjs` (unit-tested `lib/linkedin.test.mjs`):
- Guest endpoint is **relevance-sorted by default** → `buildSearchUrl` forces `sortBy=DD` (date-descending) so genuinely-new postings aren't buried past the per-page cap.
- Incremental early-stop requires **2 consecutive all-seen pages** (with `sortBy=DD` an all-seen page = older history, so this is safe).
- **`titleHardExcluded()`** drops junior / management / off-field on the **TITLE, before the JD fetch**. Driven **per-person** by `sources.json → linkedin.title_filter` (`{junior?,management?,off_field?:"qa"}`; absent = no hard filter). The automation JD-vet (`vetVerdict()`) is gated on `off_field==='qa'` — a **non-QA guest must NOT get the QA filters** (off-field/management/automation-vet all off for them; closed-check still always runs).
- `FRESH_WINDOW = 7d` caps `f_TPR` on **every** run, including a new person's first backfill.

(Full root-cause narrative, the guest QA-filter regression, and the on-demand DEEP-scan improvisation postmortem → `docs/HISTORY.md`.)

### On-demand DEEP scan (`linkedin.mjs --window-days N --no-persist`)
For chat-driven "סריקה עמוקה N יום" requests (via `prompt-self-extend.md` Path A). `--window-days N` searches the last N days, **bypassing the daily `FRESH_WINDOW` 7-day cap** with full pagination (no early-stop); `--no-persist` is **read-only** (doesn't touch the daily seen-ledger AND returns already-sent jobs too → comprehensive + repeatable). Returns compact JSON from a subprocess so a deep scan never bloats the conversational turn (this is why it's a tool, not inline improvisation — see `docs/HISTORY.md`). Pure helpers `resolveScanWindow()` + `vetVerdict()` are unit-tested. The agent CV-matches the returned candidates and marks already-sent via `ledger.mjs check`.

### Scout / Q&A discipline (durable rules)
- `prompt-scout.md` **Step 0 = 🚧 HARD PER-PERSON ISOLATION**: discard all candidate state at the start of each person's iteration; per-field self-check before each send (David's report is tagged via `people.json` `match_e164`).
- `prompt-scout.md` **Step 2 backstop**: DROP any candidate whose title/snippet shows it was posted **>~30d ago** ("לפני שנה"/"Posted 6 months ago"/old year).
- `prompt-qa.md` **Recall-questions = grounding-required**: answer recent-event questions ("what happened / do you remember / what was the bug / what did X say") **ONLY from RECENT_CHAT.md + data files** — never recite a documented example from the prompt as the recent event, never fabricate specifics, and say **"אין לי את זה בהקשר האחרון"** when it's not there.

(Full postmortems — stale-jobs, per-person leak, Q&A hallucination → `docs/HISTORY.md`.)

### Sheet columns (Apps Script tab "Jobs", A:O)
`A id(sha256[:12] of normalized company|role) · B תאריך מציאה · C מקור · D תפקיד · E חברה · F מיקום · G רמה · H ציון התאמה · I נימוק · J קישור · K סטטוס · L תאריך הגשה · M הערות · N זוהה ממייל · O עודכן`

Status (col K), exactly one: `⏳ Pending` `✅ Applied` `📞 Interview` `🎉 Offer` `❌ Rejected` `⛔ Not Interested`.

## Hard rules (NEVER violate)
1. WhatsApp sends go **only** to the configured group (the `main` agent's group in `shared/registry.json`) — never any other target. (See also the user-memory note: never guess messaging targets.)
2. Gmail is **read-only**, **owner-only** — never reply/label/modify; guests have no Gmail.
3. **Never delete a sheet row** — hide via status `⛔ Not Interested`. Exception: explicit `/delete N`. (Sheet is owner-only.)
4. **Never apply to jobs** — only surface & track.
5. **Hebrew** to the user; English for internal tool calls.
6. **Always send each enabled person a daily message** in scout mode — push new jobs, or a short heartbeat when 0 new (per David's requirement; replaces the old "0 new AND 0 status → send nothing").
7. Always include source URLs in messages.
8. **Capability gating:** owner-only tools (Sheet/Gmail/Telegram) must never run for a guest — check `people.json` capabilities. Unknown senders get the safe public persona only (no data leak).

## How to operate the tools (shell)
```bash
cd ~/open_claw/workspace-jobscout
node tools/sheet.mjs ping                       # health check (returns {"ok":true,...})
node tools/sheet.mjs read [statusFilter]        # read tracker rows
node tools/sheet.mjs append '<row-or-array>'    # add job(s)
node tools/sheet.mjs update-by-id <id> '<updates>'  # PREFER THIS: locate by stable id (col A) → update → read-back (row_after). Immune to the auto-re-sort that scrambles row numbers.
node tools/sheet.mjs update <row> '<updates>'   # update one row (row >= 2) — LEGACY/fragile (sheet re-sorts on status change/append)
node tools/sheet.mjs find <id>                   # owner-only Sheet
node tools/lib/people.mjs                         # registry resolver (resolvePerson/listEnabled/personByE164)
node tools/ledger.mjs <person> <check|add>        # per-person sent-jobs dedup (only dedup memory for guests)
node tools/search.mjs --person <id> ...           # Tavily job search (Israeli boards + Indeed/Glassdoor)
node tools/linkedin.mjs --person <id>             # LinkedIn jobs (free, no auth); 1st run=backfill, then incremental
node tools/linkedin.mjs --person <id> --window-days 30 --no-persist  # ON-DEMAND DEEP scan: N-day window (bypasses 7d cap), read-only (no ledger write, returns all incl. already-sent). For chat "סריקה עמוקה".
# reset for a fresh full backfill: rm workspace-jobscout/people/<id>/data/linkedin-seen.json
node tools/telegram.mjs fetch --person <id>       # Telegram channel (owner-only)
node tools/gmail-search.mjs --person <id> [--after-uid N]  # Gmail read-only, owner-only, INCREMENTAL (gmail-state.json)
node tools/weekly-review.mjs                      # owner-only self-review: reads Sheet → outcome funnel JSON (engagement vs noise per source/level/score). Feeds prompt-weekly-review.md.
# Self-extension safety harness (used by prompt-self-extend.md; owner-only chat self-edits):
node tools/self-edit.mjs snapshot '["skills/job-scout/<f>", ...]'  # back up files BEFORE editing → {snapshot_id}
node tools/self-edit.mjs verify                   # run unit suite + syntax-check tools + validate config JSON → {ok}
node tools/self-edit.mjs revert <snapshot_id>     # restore on failure (deletes files the edit newly created)
node tools/self-edit.mjs log '<json>' | changelog [N]   # audit trail (answers "מה שינית?")
node --test tools/lib/*.test.mjs                  # the test suite verify runs (46 tests as of 2026-06-08)
```
The `openclaw` launcher wraps the CLI with Node 22 (via nvm). Secrets: `TAVILY_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` (Gmail is read via IMAP app-password, **not** OAuth), `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`.

## Live config quick reference
**Shared** (`workspace-jobscout/.config/job-scout.json`):
- WhatsApp group: `Job Scout 🤖` (`120363000000000000@g.us`) — the one shared group for all people
- Sheet (owner-only): id `<SHEET_ID>`, edited via Apps Script webhook (`/exec` URL in config)
- Cron (two runs, tz `Asia/Jerusalem`): `0 8 * * *` FULL (`job-scout-daily`) + `0 15 * * *` LIGHT/no-Tavily (`job-scout-afternoon`, id `ef7fd460-…`). Weekly review `0 22 * * 6` (`job-scout-weekly-review`).

**WhatsApp threaded replies (`~/.openclaw/openclaw.json` → `channels.whatsapp.accounts.default`, set 2026-06-08):**
`replyToMode: "all"` — the gateway auto-attaches a quote-reference to the triggering inbound message on EVERY message Scotty sends, so replies thread onto David's messages (WhatsApp-style). Enum: `off|first|all|batched`. Picked up via openclaw's fresh-config load on the next inbound (config-watcher); `openclaw gateway restart` (when chat is idle) is the certain fallback. NOTE: openclaw's WhatsApp adapter does NOT surface the *inbound* quote/`contextInfo` (only Telegram/Feishu do), so Scotty cannot see WHICH older message David replied to or its text — that would need a vendored adapter patch (extract `contextInfo.quotedMessage`+`stanzaId` → inject into event metadata → `chat-log` hook resolves it against `data/chat-log/<group>.jsonl`). Deliberately NOT built (fragile, upgrade-wiped).

**Person registry** (`workspace-jobscout/.config/people.json`): `shared.{default_person}` + `people[]`,
each `{id, name, role:owner|guest, enabled, match_e164, capabilities:{sheet,gmail,telegram}, [sheet], [gmail], [telegram]}`.
Currently:
- **`david`** — owner, enabled, capabilities sheet+gmail+telegram all true. Gmail `owner@example.com` (read-only, incremental), Telegram channel IL_QA_Job (read-only).
- **`yossi`** — guest, enabled, all capabilities false, `match_e164: ["972500000000"]`. Push + light Q&A only; dedup via `ledger.mjs`.
- **`rani`** — guest, **enabled**, all capabilities false, `match_e164: ["972500000000"]`. Senior Technical/Program Manager (TPM/Delivery/PMO, ~15 yrs). Push + light Q&A only; dedup via `ledger.mjs`. Profile under `people/rani/` is complete (cv.pdf + cv-summary.json + profile.md + sources + locations); CV was provided in WhatsApp and recovered from `~/.openclaw/media/inbound/`.

## People / search profiles (short)
**David** (owner) — Head of QA (IDF, Prizma), ~5 yrs, ex Team Lead of 7. Senior **and** Mid OK — **IC roles only**. Stack: Playwright/Selenium/Cypress, TS/Java/JS/Python/C#/SQL. Wants QA/Automation/SDET/DevOps-automation. **NOT RPA** (business-process automation — UiPath/Blue Prism — is a different field; David confirmed 2026-06-13 it's not his, removed from preferred + added to exclusion_signals). Center-Israel + Remote-IL. **Excludes:** junior/entry, pure-manual QA, **management titles (Team Lead/Head/Manager — wants IC now)**, defense sector (Rafael/Elbit/IAI — civilian only), Herzliya, AllJobs-premium-only. Modi'in. Hebrew native, English proficient.
**Guest (`yossi`)** — finance/analyst roles (see `workspace-jobscout/people/yossi/profile/`).
**Guest (`rani`)** — Senior Technical Program / Program Manager (TPM, Delivery Manager, VP Delivery, Head of PMO, ~15 yrs). SaaS/enterprise, senior+ IC-or-management OK. **Excludes:** junior/associate/entry, QA/Developer/Engineer IC roles. See `workspace-jobscout/people/rani/profile/`.
**Search/match criteria source of truth (per person):** LinkedIn+Tavily keywords live in `workspace-jobscout/people/<id>/sources.json` (`linkedin.keywords` + `tavily.queries`); levels + exclusions in `workspace-jobscout/people/<id>/profile/cv-summary.json` (`excluded_role_titles`/`excluded_sectors`/`excluded_locations`/`exclusion_signals`). Edit criteria there, not scattered in tool code. **LinkedIn title hard-filter is per-person** (`sources.json` → `linkedin.title_filter`, added 2026-06-08): `{junior?,management?,off_field?:"qa"}`. David = `{junior,management,off_field:"qa"}` (IC QA only); the guest = `{junior}` (she wants management/VP/PMO — off-field+management buckets would wrongly nuke all her PM titles); absent = no hard title filter (rely on location + LLM CV-match). See LinkedIn tuning note above.

## Q&A sender routing (shared-group finding, 2026-05-30)
The shared group **hides the sender** from the agent turn (the LLM only sees the group, not who wrote). Fix: the
`chat-log` gateway hook writes `workspace-jobscout/data/last-inbound.json` = `{e164, fromMe, person, ts}` on every inbound;
`prompt-qa.md` Step 0 reads it and resolves **owner** (via `fromMe`) / **known guest** (by `match_e164` →
`personByE164`) / **unknown** (safe public persona, no data leak). Owner-only admin commands (`/people`,
`/disable <id>`, `/enable <id>`, hard-delete-with-confirmation) manage the registry from chat.

## Agent runtime / capabilities (verified 2026-05-26)

Conversational + cron sessions run as `claude -p` via the OpenClaw CLI backend (`--output-format stream-json --setting-sources user --allowedTools mcp__openclaw__*`), with MCP config pointing at the local OpenClaw gateway (port 18789; per-session MCP at e.g. 41293). Auth is the user's **Claude Max-5x subscription via OAuth** (`~/.claude/.credentials.json`) — billing is rate-limit bound, not per-token.

**Model resolution (verified 2026-05-26 — `SKILL.md` `model:` frontmatter is NOT parsed by OpenClaw):**
- **Daily cron scout** → `anthropic/claude-sonnet-5`, `thinking: high` (set on the cron job; `openclaw cron get 5d7587f3-…` to confirm, `openclaw cron edit <id> --model … --thinking …` to change). Heavy pipeline, 1×/day, best CV-match quality.
- **WhatsApp conversational** → inherits the agent default `anthropic/claude-sonnet-5` (`~/.openclaw/openclaw.json` `agents.defaults.model.primary`). Fast + good Hebrew; change there if needed.
- Both paths run with `--permission-mode bypassPermissions` (verified live in `ps`), so built-in tools (Bash/Read/Edit/Write) are auto-approved and the agent can shell out and edit its own skill files. Conversational sessions are launched with `--effort medium --model sonnet`; the cron path carries `model`/`thinking` in its job payload (set via `openclaw cron edit --model/--thinking`), where the OpenClaw `thinking` level maps to the underlying claude `--effort`.
- OpenClaw MCP tools exposed: `cron`, `update_plan`, `sessions_list/history/send/spawn/yield`, `session_status`, `subagents`, `web_search`, `web_fetch`, `memory_search`, `memory_get`. Messaging/sheets go via Bash → `openclaw` CLI + `tools/*.mjs` (no MCP "send" tool).
- Implication: Scotty *can* self-modify prompts from a WhatsApp chat (Sonnet, takes effect next session) but it's unreliable and ungated — and it **cannot** add secrets, OAuth scopes, new channels, or gateway hooks from chat. Build capabilities in a focused dev session here; operate the bot via chat.

## Operations & known failure modes → `../docs/RUNBOOK.md`

Historical tuning records & postmortems → `docs/HISTORY.md`.

Operational mechanisms and every root-caused failure mode live in **`../docs/RUNBOOK.md`** (not auto-loaded — read it when debugging). Index of what's there:

- **Acknowledgment hook (ack-react)** — automatic 👍 on every inbound; do NOT react from the prompt.
- **Session hygiene** — keeps the group session small so the (broken) native compactor never runs; `tools/session-hygiene.mjs` (a thin shim over `shared/lib/session-hygiene.mjs`, agentId "main") + timer; continuity via the shared `chat-log` hook → `RECENT_CHAT.md`.
- **Ghost mode** — bot suppressed phone push notifications (companion device on David's own number); fixed via `sendReadReceipts:false` + a vendored presence patch.
- **Chat reliability** — "chat crashes on my messages" = gateway restarted mid-reply; **never restart to apply prompt/skill edits (they hot-reload)**.
- **Failure mode: user-scope plugins leak into Scotty** (stall) — disabled `superpowers`; keep `~/.claude` user scope minimal.
- **Failure mode: agent harness de-registers** (`MissingAgentHarnessError`, silent bot) — config + vendored selection-guard fix; ⚠️ re-apply the patch after an openclaw upgrade.
- **Failure mode: compaction "Missing API key for provider anthropic"** — added a `claude-cli/oauth` auth profile (subscription, no API key).
- **Failure mode: "likes but doesn't reply" (compaction-poisoned session)** — the session ENTRY's `totalTokens` overruns the context window (assistant-only accumulation, e.g. daily-cron posts) → preflight compaction required but fails. Proactively cleared every 5 min by each bot's `session-hygiene` timer (now ALL 5 bots have one) and backstopped by the **multi-agent** watchdog CHECK C (loops every registry agent, scopes by `sessionKey=agent:<id>:`, resets via the shared entry-deleting reset, **no "resend" nudge**). Overhauled 2026-06-29 — see RUNBOOK "compaction-poisoned session".

⚠️ **NON-STOCK vendored patches** (ghost mode + harness de-registration) are overwritten by `npm i -g openclaw` / `openclaw update` — re-apply from `../docs/RUNBOOK.md` after any upgrade.

## 2026-07-15 overhaul (David's policy + sources revamp) — read before touching filters
- **David's policy:** junior/mid/unknown levels all pass (`title_filter.junior:false`, `internships:true` still drops interns); LLM KEEP rule is config-driven via `sources.json → scoring` (`min_score:50`, `levels_acceptable`); guests keep legacy 70/senior+mid via defaults.
- **Reposts:** `ats.mjs` tracks `seen_updated` baselines (`isRepost`, ≥21d jump ⇒ `repost:true`); LinkedIn candidates carry `posted` (card `<time datetime>`, JSON-LD fallback); prompt Step 3a repost triage (OWNER-ONLY) can resurface already-sent jobs 🔁; ledger `add` is an upsert (`first_date` preserved).
- **New providers** in `lib/ats.mjs`: workday (POST CXS, Intel/NVIDIA), amazon, smartrecruiters (Wix2), lever-eu (Mobileye), drushim (3 query feeds). Tavily = 9 X-ray queries across all ATS domains, `time_range:"week"`. Weekly review now auto-discovers new watchlist companies (cap 10/wk).
- **New prompts:** `prompt-backfill-david.md` (one-time, re-run-guarded, SKILL.md routing rule 4) and `prompt-daily-question.md` (daily 08:33 cron `jobscout-daily-question`, delivery mode none — the prompt sends itself; answers graded via prompt-qa.md, state in `data/learning/`).
- Rollback snapshot for the whole overhaul: `self-edit revert 20260715-123644-sc0r`.
