# דיגיט — US Real-Estate Investment Advisor (read this first)

> This file is auto-loaded each session. It exists so any agent working here understands the
> whole project without re-exploring. Last reviewed: 2026-06-08.

> ⚠️ **Dev note — what the conversational agent actually loads (verified 2026-06-08).** OpenClaw's
> `claude-cli` agent injects ONLY these workspace files into the system prompt: **AGENTS.md, SOUL.md,
> IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md**. It does **NOT** auto-load this `CLAUDE.md` or the
> skill's `SKILL.md`/`prompt-qa.md` (those are read on-demand only, and a casual greeting won't trigger
> a read). So **any rule that must ALWAYS apply belongs in `AGENTS.md` (or IDENTITY/SOUL)** — that is
> where the persona, the "always reply / never NO_REPLY" rule, the knowledge-file pointers, and the
> **one-time launch show** (greeting → full intro + the `@972500000000` a group member shout-out) now live.
> This CLAUDE.md is a dev map for humans, not bot context. (How this was found: `openclaw agent
> --json` → `result.meta.systemPromptReport.injectedWorkspaceFiles`.)

## What this is

**דיגיט (Digit) 🏠** is the **bot of השקעות דיגיט** (Od Sifra, odsifra.co.il) — the Israeli company
that guides investors to buy cash-flowing **turnkey US rental property** (Toledo, Ohio; BRRRR
model; from ~$40k equity; passive monthly cash flow). David built דיגיט to serve/showcase to עוד
ספרה. It answers, in Hebrew, in **one WhatsApp group ("בוט השקעות דיגיט")**, to **anyone in the group**
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

> **Relationship to "Scotty":** דיגיט is a **completely separate agent** from the job-search bot
> "Scotty" (which lives in the sibling `../workspace/`). They share ONLY the OpenClaw runtime
> (gateway + WhatsApp account) — separate workspace, skill, data, persona, and per-group routing
> mean **neither can affect the other's behavior or data**. Do NOT touch `../workspace/`.

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
- **Same WhatsApp number as Scotty, different group.** ⚠️ Known tradeoff (see `../workspace`
  RUNBOOK): the bot running on David's own number suppresses phone push notifications. Accepted.

## Layout

```
workspace-realestate/
├── CLAUDE.md / IDENTITY.md / SOUL.md / AGENTS.md / USER.md   # persona + conventions + about David
├── RECENT_CHAT.md                  # recent conversation (written by chat-log hook) — continuity
├── .config/bot.json                # group_id, drive {remote,folder,local_dir}, disclaimer, session_hygiene
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
│   ├── package.json                # { "type": "module" }
│   └── hooks/
│       ├── ack-react/              # 👍 on every inbound (deterministic ack) — adapted from Scotty
│       └── chat-log/               # mirrors chat → RECENT_CHAT.md + data/last-inbound.json (single-user; no people registry)
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
1. WhatsApp sends go **only** to the configured group (`.config/bot.json#whatsapp.group_id`).
2. **Ground deal answers in `deal-data/`** — never fabricate deal specifics; if not in docs, say so.
3. **Disclaimer** on tax/legal/entity/financial-decision answers (general guidance, not professional advice; a US CPA/attorney must confirm). Text in `bot.json`.
4. **Privacy:** his deal specifics never leave the group; web search in the abstract only.
5. **Hebrew** to David; English for internal tool calls.
6. **Cite source URLs** for external/general claims.
7. **`deal-data/` is read-only** (mirrors Drive) — never modify/delete; only maintain `deal-summary.md`.
8. **Self-modification needs a dev session** — never change skill/tools/secrets/channels/hooks/cron from chat; say so plainly in Hebrew, never pretend it's done.

## How to operate (shell)
```bash
cd /home/davidtobol2580/open_claw/workspace-realestate
node tools/drive-sync.mjs                 # sync Drive → deal-data/ (needs rclone configured)
node tools/drive-sync.mjs --dry-run       # preview what would sync
node --test tools/**/*.test.mjs           # the test suite (38 tests as of 2026-06-08)
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

## ⚙️ Wiring status — LIVE (completed 2026-06-08)
1. ✅ **WhatsApp group:** "בוט השקעות דיגיט" = `120363000000000000@g.us` (in `bot.json` + allowlisted).
2. ✅ **Agent + routing:** agent `digit` registered (`openclaw agents add`), workspace + opus-4-7;
   peer binding `{channel:whatsapp, accountId:default, peer:{kind:group, id:120363000000000000@g.us}}`
   → digit (wins over main's `{channel:whatsapp}` fallback, which is untouched). Group is
   `requireMention: true`. Hooks dir `workspace-realestate/tools/hooks` added to `hooks.internal.load.extraDirs`
   (hook names suffixed `-digit` to avoid colliding with Scotty's `ack-react`/`chat-log`).
3. ✅ **Wake-word fix:** auto-derived mention pattern uses `\b@?name\b`, and JS `\b` is ASCII-only so
   it NEVER matches a Hebrew name → set an explicit `agents.list[].groupChat.mentionPatterns: ["דיגיט"]`
   (plain substring, no `\b`). This is the reason digit was silent at first. ⚠️ Any Hebrew-named agent
   needs an explicit mentionPattern.
4. ✅ **"likes but doesn't reply" fix:** digit emitted `NO_REPLY` (group-chat silence instinct from the
   AGENTS.md template). Since `requireMention` means it ONLY sees messages addressed to it, prompt-qa.md
   Step 0 + AGENTS.md now mandate ALWAYS reply, never `NO_REPLY`.
5. ✅ **Drive:** service account + rclone live (see Drive section); synced 20 files → `deal-data/drive/`.
6. ✅ **Model:** opus-4-7 on the agent.
7. ✅ **Ghost-mode (phone notifications):** verified digit is covered by the account-level fix
   (`sendReadReceipts:false` + the `selfChatMode`-guarded presence patch in `monitor-ClhD-fQ6.js`) —
   it operates on the whole WhatsApp socket, not per-group, so no per-group setting needed.

⚠️ **channels.whatsapp.* edits need a clean `openclaw gateway restart`** (chat idle) — the live
hot-reload flaps the WhatsApp socket for minutes and drops outbound. (prompt/skill edits hot-reload fine.)
```

## ⚠️ Vendored-patch note
The OpenClaw runtime carries NON-STOCK vendored patches (ghost mode, harness de-registration)
documented in `../workspace/docs/RUNBOOK.md` — overwritten by `openclaw update`; re-apply after
upgrades. They affect the shared gateway, so they affect דיגיט too.
