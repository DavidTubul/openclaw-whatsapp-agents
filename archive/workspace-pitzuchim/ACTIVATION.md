> 🗄️ **ARCHIVED 2026-07-17 — bot retired, not in active use.** Runtime wiring removed; code/data kept for revival. See [`ARCHIVED.md`](ARCHIVED.md). Everything below is preserved as-is from when it was live.

# ACTIVATION.md — taking פיצי live (the wiring checklist)

> ✅ **Status: DONE for the test/demo group (2026-06-13)** — פיצי is wired and live there
> (`requireMention:false`). This checklist stays as the reference for re-wiring / phase-2
> (separate business number + customer DMs).

These steps connect פיצי to WhatsApp. They edit the **shared** `~/.openclaw/openclaw.json`
(the gateway running all the bots), so do them carefully.

> 📌 **Also mandatory today (added after this checklist was written)** — see the root `CLAUDE.md`
> "Adding a new agent" quickstart for the current versions of: the per-agent `session-hygiene-pitzi`
> systemd timer (every 5 min; without it the group session poisons silently), `tools.exec`
> `{security: full, ask: off}` in `openclaw.json` (or tool calls are silently denied headless),
> and the per-agent compaction auth profile (`anthropic:claude-cli` in the agent's OWN auth store).

> ⚠️ `channels.whatsapp.*` edits need a clean `openclaw gateway restart` while chat is idle — a live hot-reload
> flaps the WhatsApp socket and can drop outbound for minutes. Agent/skill/prompt file edits hot-reload fine.

## Step 1 — Create the test/demo WhatsApp group & get its group_id

1. On David's phone, create a WhatsApp group (e.g. "חנות הפיצוחים — בוט") and add the bot's number.
2. Send any message in it.
3. Read the group id from the chat-log of an existing agent, OR temporarily allowlist+observe. Quickest:
   after the group exists and a message was sent, the gateway logs the conversationId. You can also copy the
   pattern of digit's id (`...@g.us`). Put the real id into the top-level `groups` map in
   `shared/registry.json` (`{jid,label,requireMention:false}`) and add its symbolic name to the `pitzi`
   agent's `groups[]`. (⚠️ bot.json no longer carries any WhatsApp wiring — those fields were deleted; it
   holds domain config only.)

## Step 1.5 — Register the agent in `shared/registry.json` (registry v2 — single source of ALL wiring)

The shared hooks, the self-edit / session-hygiene engines, **and all WhatsApp wiring** resolve every bot
through the central registry `shared/registry.json` — now **registry v2**: a top-level `groups` map
(symbolic name → `{jid,label,requireMention,…}`), `owner` once at the top, and per-agent
`identity {name,emoji}` + symbolic `groups`/`primaryGroup` + `cronTargets`. Ensure it holds a `pitzi`
entry with the correct group (one entry per bot).

## Step 2 — Sync openclaw.json from the registry (registry-sync — do NOT hand-edit)

> ⚠️ **The old manual "edit 4 places in openclaw.json" procedure is SUPERSEDED.** openclaw.json is DERIVED
> from `shared/registry.json`. After Step 1.5, run `node ~/open_claw/shared/tools/registry-sync.mjs --check`
> (review the drift) then `--apply` — it writes the `agents.list[]` entry (incl. the explicit Hebrew
> `mentionPatterns` from `identity`), the group allowlist entry, prepends the `bindings[]` route before
> main's catch-all, sets each cron's `delivery.to`, and backs up both files to `shared/backups/registry-sync/`.
> The blocks below stay as a reference for **what registry-sync generates** — not as a hand-edit instruction.

**(a) Register the agent** — add to `agents.list[]`:
```json
{
  "id": "pitzi",
  "name": "pitzi",
  "identity": { "name": "פיצי", "emoji": "🥜" },
  "groupChat": { "mentionPatterns": ["פיצי"] },
  "workspace": "~/open_claw/workspace-pitzuchim",
  "agentDir": "~/.openclaw/agents/pitzi/agent",
  "model": "anthropic/claude-sonnet-5"
}
```
> ⚠️ The Hebrew mention pattern MUST be the explicit `["פיצי"]` (plain substring). OpenClaw's auto-derived
> `\b@?name\b` is ASCII-only and never matches Hebrew — this is exactly why דיגיט was silent at first.
> (Model: the live config is `anthropic/claude-sonnet-5` — handles the vision authenticity check fine. Change it if quality needs it.)

**(b) Allowlist the group** — under `channels.whatsapp.accounts.default.groups`, add:
```json
"<GROUP_ID>@g.us": { "requireMention": false }
```
(`requireMention:false` is the value actually chosen for פיצי — complaint photos usually arrive
**uncaptioned**, and with `requireMention:true` they would never reach the bot. `groupPolicy` is
`"allowlist"`, so an un-listed group is ignored entirely.)

**(c) Route the group to פיצי** — add as the FIRST entry in `bindings[]` (peer match wins over main's
`{channel:whatsapp}` fallback; leave Scotty's + digit's bindings untouched):
```json
{ "type": "route", "agentId": "pitzi",
  "match": { "channel": "whatsapp", "accountId": "default", "peer": { "kind": "group", "id": "<GROUP_ID>@g.us" } } }
```

**(d) Load the hooks** — the hooks are SHARED across all bots (`shared/hooks/`), loaded from a **single**
entry in `hooks.internal.load.extraDirs`, and they resolve פיצי by its group jid via `shared/registry.json`.
If the entry is already present (another bot wired it), there is nothing to add. Otherwise:
```json
"~/open_claw/shared/hooks"
```
(The old per-workspace `workspace-pitzuchim/tools/hooks` dir was deleted in the 2026-06-26 shared-infra refactor — do not point at it.)

## Step 3 — Restart the gateway (chat idle)
```bash
~/open_claw/openclaw gateway restart
```
Then send "פיצי, מי אתה?" in the group → expect a 👍 and a Hebrew intro.

## Step 4 (recommended) — the Google Sheet dashboard (human monitoring: who said what + cases)
The single human-facing view. ONE Sheet, TWO tabs auto-created on first write:
- **"שיחות"** — every message in/out: time · שיחה · כיוון · שם לקוח · טלפון · הודעה. Scroll it to see exactly
  what פיצי wrote and to whom. Mirrored LIVE by the shared `chat-log` hook.
- **"תיקים"** — complaint cases + decisions + status. Mirrored LIVE by `cases.mjs`.

Setup:
1. Follow the SETUP comment block at the top of `tools/apps-script-webhook.gs` (create Sheet → paste script →
   set `SHEET_ID` → deploy as Web app → copy the `/exec` URL).
2. Put the URL in `.config/bot.json` → `sheet.webhook_url`, set `sheet.enabled: true`.
3. **Restart the gateway** (`openclaw gateway restart`, chat idle) — this loads the hook's live-push code AND the
   per-message customer identity (phone + WhatsApp name) capture. (Until this restart, chat-log lines won't carry
   names; that's fine — the Sheet isn't live yet either.)
4. `node tools/sheet-sync.mjs ping`  → expect `ok:true`.
5. `node tools/sheet-sync.mjs backfill`  → loads existing chat history into "שיחות".
   `node tools/sheet-sync.mjs backfill-cases`  → loads existing cases into "תיקים".
6. From now on, every message + case appears in the Sheet automatically (near-live, best-effort). If the webhook
   is ever briefly down, rows stay in the local JSONL — re-run `sheet-sync backfill --since <ISO>` to repair.

Until set up, everything is still recorded locally: `data/chat-log/<group>.jsonl` (full transcript) and
`data/cases/cases.jsonl` (`node tools/cases.mjs export-csv` for a CSV a human can open).

## Step 5 — Smoke test the complaint flow
1. In the group: "פיצי, הפיצוחים לא טריים".
2. Send a front + back photo of a bag (any bag, for the demo).
3. Confirm: פיצי asks for both photos → reads them → makes a policy decision → a row appears via
   `node tools/cases.mjs list`.

## Rollback
Remove the 4 edits from `openclaw.json` (the agent entry, the group, the binding, the hooks dir) and restart
the gateway. The `workspace-pitzuchim/` dir is self-contained — deleting it removes פיצי entirely with zero
effect on the other agents.
