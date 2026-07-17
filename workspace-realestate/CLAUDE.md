# דיגיט — US Real-Estate Investment Advisor (read this first)

> This file is auto-loaded each session. It exists so any agent working here understands the
> whole project without re-exploring. Last reviewed: 2026-07-13.

> ⚠️ **Dev note — what the conversational agent actually loads.** Only the 6 persona files (AGENTS.md,
> SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md) are injected; any always-on rule must live in
> AGENTS.md. (Found via `openclaw agent --json` → `result.meta.systemPromptReport.injectedWorkspaceFiles`.)
> Full explanation → `../CLAUDE.md`.

## What this is

**דיגיט (Digit) 🏠** is the **bot of השקעות דיגיט** (Od Sifra, odsifra.co.il) — the Israeli company
that guides investors to buy cash-flowing **turnkey US rental property** (Toledo, Ohio; BRRRR
model; from ~$40k equity; passive monthly cash flow). David built דיגיט to serve/showcase to עוד
ספרה. It answers, in Hebrew, across **two configured WhatsApp groups** (a primary group + a team
consultation group — see the "⚙️ Multi-group" section), to **anyone in the group**
(David, the השקעות דיגיט team, prospective investors):

1. **The השקעות דיגיט process** — the 13-step journey (intro → LLC → Mercury bank → initial capital →
   sourcing → contract → inspection → lender → title → ownership → rehab → rent → refinance).
   Grounded in `skills/realestate-advisor/company.md`.
2. **The Toledo/Ohio market & domain** — prices/rents/yields, neighborhood classes, property tax,
   landlord law, DSCR/foreign financing, BRRRR/ARV, risks. Grounded in `skills/realestate-advisor/market.md`.
3. **The investor's specific deal** — grounded **exclusively** in `deal-data/drive/` (synced from
   Drive: contracts, LLC docs, terms). Never fabricates deal specifics.
4. **US RE investing in general** — tax (LLC, ITIN, FIRPTA), Mercury bank, financing, risk. Time-
   sensitive facts (rates/rules) are web-searched + cited.

The name דיגיט = "ספרה" — it's השקעות דיגיט's extra digit. It is **conversational only** (no cron),
**responds only when addressed as "דיגיט"** (`requireMention`), and **anyone** in the group may trigger it.

> **Relationship to Scotty:** דיגיט is a **completely separate agent**; the repo hosts five bots that
> share only the gateway — see `../CLAUDE.md`. Do NOT touch the sibling workspaces.

## Separation & runtime model (the architecture)

- **Same OpenClaw runtime, separate isolated agent.** Registered via `openclaw agents add` with
  this dir as `--workspace`. Routing is **per WhatsApp group** (peer-level binding), so this
  group's messages go to דיגיט and Scotty's group stays with Scotty.
- **Routing (hand-edited in `~/.openclaw/openclaw.json` `bindings`):** OpenClaw's route engine
  checks `match.peer` FIRST (most specific), then account, then channel. So the binding
  `{agentId:"<this agent id>", match:{channel:"whatsapp", accountId:"default", peer:{kind:"group", id:"<RE_GROUP>@g.us"}}}`
  wins for this group, while Scotty's existing `{channel:"whatsapp"}` binding remains the
  fallback for everything else — **Scotty's binding is left untouched.**
- **Wake-word / name trigger (per David's requirement — responds ONLY when called by name):**
  set `requireMention: true` on this group in `channels.whatsapp.accounts.default.groups`.
  OpenClaw auto-derives a mention pattern from the agent's `identity.name` ("דיגיט") → regex
  `\b@?דיגיט\b`, gated **before the LLM** (deterministic, not prompt-level). To add aliases,
  set `agents.list[].groupChat.mentionPatterns: ["@?דיגיט", ...]`. Messages without the name
  are dropped and never reach the agent.
- **Same WhatsApp number as Scotty, different group.** ⚠️ Known tradeoff (see `../docs/RUNBOOK.md`):
  the bot running on David's own number suppresses phone push notifications. Accepted.

## Layout

```
workspace-realestate/
├── CLAUDE.md / IDENTITY.md / SOUL.md / AGENTS.md / USER.md   # persona + conventions + about David
├── RECENT_CHAT.md                  # recent conversation (written by chat-log hook) — continuity
├── .config/bot.json                # DOMAIN config only: drive {remote,folder,local_dir}, disclaimer. Group ids + session-hygiene now live in shared/registry.json (registry-v2 refactor)
├── deal-data/
│   ├── drive/                      # 📄 READ-ONLY mirror of David's Drive deal folder (synced; subfolders preserved)
│   │   └── .manifest.json          #   written by drive-sync (what was last synced)
│   ├── deal-summary.md             #   the ONE file the agent maintains: distilled, document-sourced digest (outside drive/)
│   └── README.md
├── skills/realestate-advisor/
│   ├── SKILL.md                    # entry, mode routing, hard rules, tools table
│   ├── prompt-qa.md                # the ONLY mode: grounded Q&A flow (classify → ground → privacy → answer → digest)
│   └── router.md                   # intent table (/sync, /deal, /docs, /help) + grounding rules
├── tools/
│   ├── drive-sync.mjs              # rclone Drive→deal-data/ sync (--dry-run/--verbose); writes .manifest.json
│   ├── drive-sync.test.mjs
│   └── package.json                # { "type": "module" }
│                                   # gateway hooks are SHARED (shared/hooks/), resolve digit by group
│                                   # via the registry — NOT a per-workspace tools/hooks dir (deleted 2026-06-26)
└── data/
    ├── chat-log/<group>.jsonl      # append-only full chat record
    └── last-inbound.json           # {e164, fromMe, person:null, ts, messageId}
```

## The skill (`skills/realestate-advisor/`)

- `SKILL.md` — persona, 3-way mode routing (`/sync`, `/deal`, free-form Q&A), 8 hard rules, tools.
- `prompt-qa.md` — the core: Step 1 classify (deal / general / command), Step 2 **grounding**
  (deal facts only from `deal-data/`, else "אין לי את זה במסמכים של העסקה" — never fabricate),
  Step 3 **privacy** (web queries in the abstract, never David's private details), Step 4 answer
  (Hebrew, cited, disclaimer on tax/legal/financial), Step 5 maintain `deal-summary.md`.
- `router.md` — command + Hebrew-NL intent table + the grounding rules in brief.

## Hard rules (NEVER violate)
1. WhatsApp sends go **only** to a configured group — one of the `digit` agent's groups in `shared/registry.json` (the agent now serves more than one). Always reply in the group the message came from.
2. **Ground deal answers in `deal-data/`** — never fabricate deal specifics; if not in docs, say so.
3. **Disclaimer** on tax/legal/entity/financial-decision answers (general guidance, not professional advice; a US CPA/attorney must confirm). Text in `bot.json`.
4. **Privacy:** his deal specifics never leave the group; web search in the abstract only.
5. **Hebrew** to David; English for internal tool calls.
6. **Cite source URLs** for external/general claims.
7. **`deal-data/` is read-only** (mirrors Drive) — never modify/delete; only maintain `deal-summary.md`.
8. **Self-modification needs a dev session** — never change skill/tools/secrets/channels/hooks/cron from chat; say so plainly in Hebrew, never pretend it's done.

## How to operate (shell)
```bash
cd ~/open_claw/workspace-realestate
node tools/drive-sync.mjs                 # sync Drive → deal-data/ (needs rclone configured)
node tools/drive-sync.mjs --dry-run       # preview what would sync
node --test tools/**/*.test.mjs           # the test suite
```
The `../openclaw` launcher wraps the CLI with Node 22 (via nvm). Secrets: `TAVILY_API_KEY` (web search).

## Drive integration (LIVE as of 2026-06-08)
- **rclone + a read-only Google service account** (chosen for headless/cron reliability over the
  claude.ai MCP Drive connector — no browser/OAuth-token dance). The rclone remote `gdrive` is a
  service account (`<SERVICE_ACCOUNT_EMAIL>`, key at
  `~/.openclaw/secrets/gdrive-sa.json`, chmod 600) with `scope=drive.readonly`,
  `root_folder_id=<DRIVE_FOLDER_ID>` (David's shared deal folder, shared with the
  SA email as Viewer), and `export_formats=pdf` (Google-native docs auto-export to PDF). To
  re-create: `rclone config create gdrive drive scope=drive.readonly service_account_file=<key> root_folder_id=<id> export_formats=pdf`.
- `node tools/drive-sync.mjs` runs `rclone sync gdrive: → deal-data/drive/` (`drive.folder=""`
  because `root_folder_id` already pins the shared folder). It syncs into the **`drive/` subdir** so
  `rclone sync`'s delete-to-match never touches the agent-owned `deal-data/deal-summary.md`.
- The corpus is small (one deal, ~20 files, ~10MB) → **direct read, no RAG / vector DB.** The
  agent reads PDFs in `deal-data/drive/` on demand. If it grows large, revisit (add embeddings).

## 📧 Gmail mirror (built 2026-07-15; spec: ../docs/superpowers/specs/2026-07-15-digit-gmail-sync-design.md)
- **`node tools/gmail-sync.mjs`** (`--dry-run/--verbose/--full/--alerts`) mirrors the David+Yonatan company
  Gmail (regular @gmail.com, **IMAP + App Password**, read-only via BODY.PEEK — no OAuth) into
  `data/mail/`: one Markdown per message under `messages/`, `INDEX.md` (digit's ONLY entry point —
  grep it, open specific files, never bulk-read), `state.json` (UID-incremental; UIDVALIDITY change →
  auto full re-mirror), `pending-attention.json` (threads whose last message is inbound = "not
  replied", newer than the previous **alert** run; alert-once, no re-nag). ⚠️ `pending-attention.json`
  is written **only by `--alerts` runs** against a separate baseline in `alert-state.json`
  (`{uidValidity, alertedUid}`) — on-demand syncs never touch either, so they can't suppress the cron
  alert, and a state reset re-baselines silently instead of re-spamming the backlog. Creds:
  `~/.openclaw/secrets/gmail-digit.env` (chmod 600; the tool reads it directly — no gateway env
  needed). Pure logic + 23 tests: `tools/lib/mail-core.mjs`, `node --test tools/gmail-sync.test.mjs`.
- **Cron `digit-mail-check`** (OpenClaw native, NOT systemd): `0 7,16 * * *` Asia/Jerusalem, isolated
  digit run, announce → the DY group ONLY. Prompt: `node tools/gmail-sync.mjs --alerts` → read pending-attention.json → empty/failed
  ⇒ exact `NO_REPLY`; else per-mail Hebrew summary + recommendation. Mail content is allowed only in
  the consultation + DY groups (AGENTS.md §📧, router `/mail`).
- ⚠️ Currently **disabled** pending real creds in gmail-digit.env (Task 6 of the plan:
  `../docs/superpowers/plans/2026-07-15-digit-gmail-sync-plan.md`). Enable:
  `../openclaw cron enable <id of digit-mail-check>` after a successful `--full` backfill.

## ⚙️ Multi-group (added 2026-06-21, reshaped 2026-07-14)
דיגיט now serves **two answering groups + one listen-only group** (same agent, same workspace,
**same deal-data**; real ids in `.config/bot.json` + `shared/registry.json`):
- "נדלן בארהב -התייעצות" (team consultation group) — **primary** since 2026-07-14
- "DY - USA 🇺🇸 & ISRAEL 🇮🇱" — added 2026-07-14
- "דוד ויונתן בדרך ל🇺🇸🏡" (the ex-primary) — **listen-only** since 2026-07-14: routed to the shadow
  agent `listener` (haiku, `workspace-listener/`), which NO_REPLYs every message so nothing is ever
  posted there (not even when "דיגיט" is called), while each message is durably captured and exported
  every 15 min by `shared/tools/listen-export.mjs` (systemd timer) into digit's
  `data/chat-log/<jid>.jsonl`. Daily `reflect` distills it into `data/memory/group-notes.md`;
  digit's `AGENTS.md` directs it to read that chat-log when asked about this group from the other
  groups. This group is deliberately **absent** from `registry.json`/`bot.json` group lists (no 👍
  ack, no hygiene notices there). Full pattern: `../CLAUDE.md` "Listen-only group mode". Pre-change
  backup: `../backups/digit-group-david-yonatan-20260714/`.
  ⚠️ Residual bug fixed 2026-07-15: OpenClaw's NATIVE ack (`channels.whatsapp.ackReaction`, scope
  "mentions") still 👍'd every message here because `requireMention:false` ⇒ activation "always" ⇒
  counts as mention. Fixed globally: `ackReaction.group:"never"` — the shared `ack-react` hook is now
  the only group-👍 source, and it correctly skips this non-registry group.

To add a group: (a) add it to the top-level `groups` map in `shared/registry.json` (`{jid,label,requireMention:true}`)
and append its symbolic name to the `digit` agent's `groups[]`; (b) `node shared/tools/registry-sync.mjs --apply`
(derives the openclaw.json route binding + allowlist entry + cron targets); (c) clean `openclaw gateway restart`
while idle. Do NOT hand-edit openclaw.json or bot.json.
Both hooks are group-aware (now the SHARED `shared/hooks/` packs, resolving digit by group jid via
`shared/registry.json`): `ack-react` 👍s in whichever configured group the message came
from; `chat-log` keys its `data/chat-log/<group>.jsonl` + regenerates `RECENT_CHAT.md` off the
**active** group (so recall reflects the group being answered, no cross-group mixing). The shared hook
set is now **four hooks** (incl. `group-memory`, which injects `data/memory/group-notes.md` — rewritten
daily by `shared/tools/reflect.mjs`) and serves digit too. All of digit's groups (incl. the listen-only one) are defined in `shared/registry.json` — bot.json no longer carries any group ids.

## ⚙️ Wiring status — LIVE (completed 2026-06-08)
1. ✅ **WhatsApp group:** "בוט השקעות דיגיט" = `120363000000000000@g.us` (defined in `shared/registry.json`, allowlisted in openclaw.json via registry-sync).
2. ✅ **Agent + routing:** agent `digit` registered, workspace + `anthropic/claude-sonnet-5`;
   peer binding `{channel:whatsapp, accountId:default, peer:{kind:group, id:120363000000000000@g.us}}`
   → digit (wins over main's `{channel:whatsapp}` fallback, which is untouched). Group is
   `requireMention: true`. Hooks: originally a per-workspace `workspace-realestate/tools/hooks` dir
   (names suffixed `-digit`); since the 2026-06-26 shared-infra refactor that dir is **deleted** and all
   bots load the single SHARED packs from `shared/hooks` via `hooks.internal.load.extraDirs` (one entry),
   which resolve digit by its group jid through the registry.
3. ✅ **Wake-word fix:** auto-derived mention pattern uses `\b@?name\b`, and JS `\b` is ASCII-only so
   it NEVER matches a Hebrew name → set an explicit `agents.list[].groupChat.mentionPatterns: ["דיגיט"]`
   (plain substring, no `\b`). This is the reason digit was silent at first. ⚠️ Any Hebrew-named agent
   needs an explicit mentionPattern.
4. ✅ **"likes but doesn't reply" fix:** digit emitted `NO_REPLY` (group-chat silence instinct from the
   AGENTS.md template). Since `requireMention` means it ONLY sees messages addressed to it, prompt-qa.md
   Step 0 + AGENTS.md now mandate ALWAYS reply, never `NO_REPLY`.
5. ✅ **Drive:** service account + rclone live (see Drive section); synced 20 files → `deal-data/drive/`.
6. ✅ **Model:** `anthropic/claude-sonnet-5` on the agent.
7. ✅ **Ghost-mode (phone notifications):** verified digit is covered by the account-level fix
   (`sendReadReceipts:false` + the `selfChatMode`-guarded presence patch in `monitor-ClhD-fQ6.js`) —
   it operates on the whole WhatsApp socket, not per-group, so no per-group setting needed.

⚠️ **channels.whatsapp.* edits need a clean `openclaw gateway restart`** (chat idle) — the live
hot-reload flaps the WhatsApp socket for minutes and drops outbound. (prompt/skill edits hot-reload fine.)

## ⚠️ Vendored-patch note
NON-STOCK gateway patches are documented in `../docs/RUNBOOK.md`; `openclaw update` wipes them.
Re-apply after upgrades — they affect the shared gateway, so דיגיט too.
