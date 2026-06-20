# ACTIVATION.md — taking פיצי live (the wiring checklist)

Everything in this workspace is built but **not wired**. These steps connect פיצי to WhatsApp. They edit the
**shared** `~/.openclaw/openclaw.json` (the gateway running Scotty + דיגיט + דילר), so do them carefully.

> ⚠️ `channels.whatsapp.*` edits need a clean `openclaw gateway restart` while chat is idle — a live hot-reload
> flaps the WhatsApp socket and can drop outbound for minutes. Agent/skill/prompt file edits hot-reload fine.

## Step 1 — Create the test/demo WhatsApp group & get its group_id

1. On David's phone, create a WhatsApp group (e.g. "חנות הפיצוחים — בוט") and add the bot's number.
2. Send any message in it.
3. Read the group id from the chat-log of an existing agent, OR temporarily allowlist+observe. Quickest:
   after the group exists and a message was sent, the gateway logs the conversationId. You can also copy the
   pattern of digit's id (`...@g.us`). Put the real id into:
   - `workspace-pitzuchim/.config/bot.json` → `whatsapp.group_id`
   - the three places in Step 2 below.

## Step 2 — Edit ~/.openclaw/openclaw.json (4 edits)

**(a) Register the agent** — add to `agents.list[]`:
```json
{
  "id": "pitzi",
  "name": "pitzi",
  "identity": { "name": "פיצי", "emoji": "🥜" },
  "groupChat": { "mentionPatterns": ["פיצי"] },
  "workspace": "/home/davidtobol2580/open_claw/workspace-pitzuchim",
  "agentDir": "/home/davidtobol2580/.openclaw/agents/pitzi/agent",
  "model": "anthropic/claude-opus-4-7"
}
```
> ⚠️ The Hebrew mention pattern MUST be the explicit `["פיצי"]` (plain substring). OpenClaw's auto-derived
> `\b@?name\b` is ASCII-only and never matches Hebrew — this is exactly why דיגיט was silent at first.
> (Model: opus is best for the vision authenticity check; sonnet is cheaper. Your call.)

**(b) Allowlist the group** — under `channels.whatsapp.accounts.default.groups`, add:
```json
"<GROUP_ID>@g.us": { "requireMention": true }
```
(`groupPolicy` is `"allowlist"`, so an un-listed group is ignored entirely.)

**(c) Route the group to פיצי** — add as the FIRST entry in `bindings[]` (peer match wins over main's
`{channel:whatsapp}` fallback; leave Scotty's + digit's bindings untouched):
```json
{ "type": "route", "agentId": "pitzi",
  "match": { "channel": "whatsapp", "accountId": "default", "peer": { "kind": "group", "id": "<GROUP_ID>@g.us" } } }
```

**(d) Load the hooks** — add to `hooks.internal.load.extraDirs`:
```json
"/home/davidtobol2580/open_claw/workspace-pitzuchim/tools/hooks"
```

## Step 3 — Restart the gateway (chat idle)
```bash
/home/davidtobol2580/open_claw/openclaw gateway restart
```
Then send "פיצי, מי אתה?" in the group → expect a 👍 and a Hebrew intro.

## Step 4 (recommended) — the Google Sheet dashboard (human monitoring: who said what + cases)
The single human-facing view. ONE Sheet, TWO tabs auto-created on first write:
- **"שיחות"** — every message in/out: time · שיחה · כיוון · שם לקוח · טלפון · הודעה. Scroll it to see exactly
  what פיצי wrote and to whom. Mirrored LIVE by the `chat-log-pitzi` hook.
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
