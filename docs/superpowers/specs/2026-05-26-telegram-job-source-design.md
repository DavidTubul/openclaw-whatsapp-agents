# Telegram channel as a job source — Design

**Date:** 2026-05-26
**Status:** Approved (design); pending implementation plan
**Author:** Scotty dev session (David Tubul / OpenClaw)

## Goal

Add the public Telegram channel **`IL_QA_Job`** ("IL QA Jobs Testing & Automation", ~3,578 members)
as a **third job source** alongside LinkedIn and the Tavily-scraped Israeli boards. Jobs found in
Telegram must flow through the **exact same pipeline** as every other source: CV-match scoring,
location filtering, Google Sheet tracking, and the daily WhatsApp report. The pull must run
**automatically every morning** (existing 09:00 Asia/Jerusalem cron) and on the manual `/scout`
command, with **no recurring manual action in Telegram** — only a single one-time login.

## Key constraint discovered

The channel has its **public web preview disabled**. Verified empirically:

- `curl https://t.me/s/durov` → 200, 19 rendered message blocks (control: preview enabled).
- `curl https://t.me/s/IL_QA_Job` → **302 redirect** to `https://t.me/IL_QA_Job` (the "open in app"
  landing page), 0 message blocks — even with a cookie jar / second request.

Therefore **scraping without authentication is impossible**. The only reliable path is the Telegram
**MTProto** client API, authenticated as David's own Telegram account (he is/will be a member of the
public channel). The Bot API is rejected (a bot cannot read a third-party channel it doesn't admin),
and a headless-browser approach is rejected as slow/brittle.

## Approaches considered

- **A — Node + gramjs (`telegram` npm), chosen.** Consistent with existing `.mjs` tools (all Node 22),
  single runtime, no new language. Field extraction (role/company/location) is done by the LLM in the
  existing scoring step, because posts are free-text Hebrew.
- **B — Python + Telethon.** Most mature MTProto lib, but introduces a Python runtime the project
  doesn't have. Rejected for consistency.
- **C — Regex/heuristic extraction inside the tool.** Brittle for free-text Hebrew job posts.
  Rejected; the LLM already performs the matching reasoning.

## Architecture

### New tool: `workspace/tools/telegram.mjs`

A Node CLI built on **gramjs** (`telegram` npm package), mirroring the conventions of `search.mjs`
and `gmail-search.mjs`. Reads credentials from environment variables (same mechanism as
`gmail-search.mjs` reading `process.env.GMAIL_*`):

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — from https://my.telegram.org.
- `TELEGRAM_SESSION` — gramjs `StringSession`, produced by the one-time `login`.

**Commands:**

| Command | Behavior |
|---|---|
| `login` | One-time, interactive. Reads `API_ID`/`API_HASH` from env; prompts for phone → SMS code → 2FA password (if set); prints the resulting `StringSession`. Run by David in his own terminal (needs interactive stdin). Does not write any secret itself. |
| `fetch` | Daily/automatic. Connects with `TELEGRAM_SESSION`; for each configured channel, pulls messages newer than the stored `last_seen_id` (capped by `max_messages_per_run`, windowed by `lookback_hours`); applies the location filter; prints candidates JSON; updates the since-marker. |

**`fetch` output shape** — identical to `search.mjs` so the pipeline merges it transparently:

```json
{"ok":true,"count":N,"candidates":[
  {"source":"telegram:IL_QA_Job",
   "title":"", "company":"", "location":"",
   "url":"https://t.me/IL_QA_Job/<msg_id>",
   "snippet":"<full message text>",
   "score":0, "msg_id":<int>, "date":"<iso8601>"}
]}
```

- `title`/`company`/`location` are intentionally **empty** — filled by the LLM in scout Step 2 from
  `snippet` (free-text Hebrew). `url` is the message **permalink** (satisfies hard rule #7: always cite
  a clickable source URL).
- On failure (expired session, network): prints `{"ok":false,"error":"<msg>"}` and exits non-zero.
  If the error indicates an invalid/expired session, the message is recognizable (e.g. contains
  `AUTH_KEY` / `session`) so the pipeline can surface a re-login notice.

**Location filter:** reuse the same logic as `search.mjs` (`allowed-locations.json`: block
Jerusalem/Haifa/etc; allow center-Israel; lenient when no city is mentioned → kept). To avoid drift,
the filter logic should be factored into a tiny shared module (e.g. `tools/lib/location-filter.mjs`)
imported by both `search.mjs` and `telegram.mjs`. (If sharing proves invasive, duplicate the small
function and note it — but prefer sharing.)

### Configuration: `workspace/.config/job-scout.json`

New section:

```json
"telegram": {
  "channels": ["IL_QA_Job"],
  "max_messages_per_run": 100,
  "lookback_hours": 48
}
```

Single channel today; the array supports adding more later with no code change.

### State: `workspace/data/telegram-state.json`

```json
{ "IL_QA_Job": { "last_seen_id": 12345, "updated_at": "<iso>" } }
```

Per-channel monotonic message-id marker. Created on first run. `fetch` reads it, pulls only
`id > last_seen_id`, and writes the new max id at the end (only if the run succeeded).

### Secrets: `~/.config/systemd/user/openclaw-gateway.service.d/secrets.conf`

Three new `Environment=` lines (same file/mechanism as the existing `TAVILY_API_KEY` / `GMAIL_*`):

```
Environment=TELEGRAM_API_ID=...
Environment=TELEGRAM_API_HASH=...
Environment=TELEGRAM_SESSION=...
```

After editing: `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`.

### Dependency

Add `telegram` (gramjs) to `workspace/tools/package.json` via `npm install telegram` in that dir
(a `package.json` + `node_modules` already exist there for `imapflow`).

## Data flow (scout pipeline integration)

Edit `workspace/skills/job-scout/prompt-scout.md` to add **Step 1b** immediately after Step 1
(Tavily search):

```bash
cd ~/open_claw/workspace/tools && node telegram.mjs fetch
```

Parse its `candidates` and **merge into the same list** as the Tavily/LinkedIn candidates. Everything
downstream is unchanged:

- **Step 2 (CV scoring):** for `telegram:*` candidates, the LLM derives `level`, `title`, `company`,
  and `location` from `snippet` (Hebrew free text) before scoring. Same threshold:
  keep if `level ∈ {senior, mid}` OR `score >= 70`.
- **Step 3 (dedupe):** unchanged — `sha256(url)[:12]` against existing Sheet ids. Telegram permalinks
  are unique per message, so this works identically.
- **Step 4 (append to Sheet):** unchanged. `source` column = `telegram:IL_QA_Job`.
- **Steps 6–7 (WhatsApp report):** unchanged. Telegram jobs appear in the `🆕` list with their
  permalink under `🔗`.

### Two-layer dedup

1. **Since-marker** (`telegram-state.json`) — avoids re-pulling history each day; primary mechanism.
2. **`sha256(url)` vs Sheet ids** (existing Step 3) — final guard against double-posting even if a
   message is fetched twice. Together: zero duplicates.

### Failure handling

If `telegram.mjs fetch` returns `{"ok":false,...}` or errors, the pipeline **ignores Telegram and
continues** with the other sources (consistent with how a single failed Tavily query is skipped
today). If the error indicates an expired/invalid session, append a line to the WhatsApp report:

> ⚠️ צריך login מחדש לטלגרם (דורש dev session)

## One-time setup sequence

1. David obtains `api_id` + `api_hash` from https://my.telegram.org.
2. Add `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` to `secrets.conf`; `daemon-reload` + restart gateway.
3. David runs `node telegram.mjs login` interactively in his terminal (phone → SMS code → 2FA),
   copies the printed session string.
4. Add `TELEGRAM_SESSION` to `secrets.conf`; `daemon-reload` + restart gateway.
5. From then on, `fetch` runs automatically in the 09:00 cron and on `/scout`. The session persists
   for months; if it ever expires, the WhatsApp re-login notice fires.

## Documentation updates

- Add a `tools/telegram-fetch.md` how-to under `workspace/skills/job-scout/tools/` (mirrors the
  existing `tavily-search.md` etc.).
- Update the SKILL.md "Real tools" table with the Telegram fetch row.
- Update project `CLAUDE.md`: add `telegram.mjs` to the tools list, the `telegram` config section,
  the new secrets, and mention Telegram as a third source in the "five things" intro.

## Out of scope (YAGNI)

- Multiple channels beyond `IL_QA_Job` (structure supports it; not configured now).
- Posting/replying in Telegram (read-only, mirrors the Gmail read-only rule).
- Real-time/push ingestion — daily batch via the existing cron is sufficient.
- Media/attachment parsing — text posts only.

## Hard rules respected

- Read-only on Telegram (never post/reply) — new analogue of the Gmail read-only rule.
- WhatsApp sends still go only to the configured group.
- Source URL (message permalink) always cited.
- Never apply to jobs; only surface and track.
