# פיצי — חנות הפיצוחים Customer-Service Bot (read this first)

> Auto-loaded each session so any agent understands the whole project without re-exploring.
> Created 2026-06-13. **Status: BUILT, NOT YET WIRED LIVE** — see `ACTIVATION.md`.

> ⚠️ **What the conversational agent actually loads** (same as digit): OpenClaw's `claude-cli` agent
> injects ONLY **AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md** into the system
> prompt. It does **NOT** auto-load this `CLAUDE.md` or the skill's `SKILL.md`/`prompt-*.md`/`business.md`
> (read on-demand only). So any rule that must ALWAYS apply lives in **`AGENTS.md`** (persona, always-reply,
> knowledge-file pointers, the complaint routing, the 📸 photo-reading instruction). This CLAUDE.md is a
> dev map for humans.

## What this is

**פיצי (Pitzi) 🥜** is the **customer-service bot of חנות הפיצוחים** — a nuts/seeds shop. It answers
**customers** in Hebrew over WhatsApp:
1. **Business info** — hours, address, phone, delivery, payment, kashrut (grounded in `skills/customer-service/business.md`).
2. **FAQ** — products, prices, returns, gift packs, event orders.
3. **Complaints — the core flow**: the **freshness complaint** (`prompt-complaint.md`) — request front+back
   bag photos → verify authenticity (vision) → read expiry → decide per policy → entitle to **2 replacement
   packages** when eligible → **log every case** to a human-verifiable tracker. A human ships; the bot decides & records.

Conversational only (no cron). Responds when addressed as **"פיצי"** (`requireMention`).

> **Relationship to the other agents:** פיצי is a **completely separate agent** from Scotty (`../workspace/`),
> דיגיט (`../workspace-realestate/`), and דילר (poker, `../workspace-poker/`). They share ONLY the OpenClaw
> runtime (gateway + WhatsApp account) — separate workspace, skill, data, persona, per-group routing. Do NOT
> touch the other workspaces.

## Deployment phases (per David, 2026-06-13)
- **Phase 1 (now — MVP):** a dedicated WhatsApp **test/demo group** on the existing number, `requireMention=true`,
  wake-word "פיצי". For David to test + demo to the business.
- **Phase 2 (future):** a **separate WhatsApp number** for the business + answering **customer DMs**. Requires a
  dev session: connect a new WhatsApp account/channel in the gateway, set `dmPolicy:"enabled"` (currently the
  account `dmPolicy:"disabled"`), and adjust always-reply for DMs (already covered in AGENTS.md). NOT doable from chat.

## Layout
```
workspace-pitzuchim/
├── CLAUDE.md / IDENTITY.md / SOUL.md / AGENTS.md / USER.md / TOOLS.md / HEARTBEAT.md
├── RECENT_CHAT.md                  # recent conversation (chat-log-pitzi hook) — continuity
├── ACTIVATION.md                   # 🔌 the wiring checklist to take it live (group id, openclaw.json, Sheet)
├── .config/bot.json                # group_id, bot {name,emoji,mention}, compensation_policy, sheet, media dir
├── skills/customer-service/
│   ├── SKILL.md                    # entry, mode routing, hard rules, tools
│   ├── prompt-qa.md                # business/FAQ Q&A flow (grounded in business.md)
│   ├── prompt-complaint.md         # 🥜 the freshness-complaint workflow (photos→auth→policy→log→reply)
│   ├── router.md                   # intent table
│   └── business.md                 # the shop's facts (⚠️ web-sourced, UNVERIFIED — David must confirm)
├── tools/
│   ├── cases.mjs                   # case/complaint ledger CLI (append/list/read/update/claims/stats/export-csv)
│   ├── cases.test.mjs
│   ├── lib/policy.mjs              # deterministic compensation decision (expiry math + policy) — unit-tested
│   ├── lib/policy.test.mjs
│   ├── apps-script-webhook.gs      # Apps Script for the optional Google Sheet tracker
│   ├── package.json                # { "type": "module" }
│   └── hooks/
│       ├── ack-react-pitzi/        # 👍 on every inbound (deterministic ack)
│       └── chat-log-pitzi/         # chat → RECENT_CHAT.md + last-inbound.json (+ inbound media refs)
└── data/
    ├── cases/cases.jsonl           # 📒 the case tracker (source of truth). cases.csv = `cases.mjs export-csv`
    ├── chat-log/<group>.jsonl      # append-only full chat record
    └── last-inbound.json           # {e164, fromMe, ts, messageId, media[]}
```

## The complaint workflow (the value)
`prompt-complaint.md`: Step1 empathize + ask for **front+back** photos → Step2 find latest images in
`~/.openclaw/media/inbound/` and **Read** them (vision) → Step3 **authenticity gate** (real bag, brand, both
sides, expiry legible, not a screenshot/web image; `cases.mjs claims <phone>` for repeat-abuse) → Step4 read
expiry → Step5 `tools/lib/policy.mjs#decideCompensation` (eligible ⇔ authentic ∧ front+back ∧ within quota ∧
expiry ≥ `min_days_to_expiry`) → Step6 `cases.mjs append` (always log) → Step7 reply (eligible→2 packages +
collect shipping; else→"ממתין לבדיקת אדם"). **A human fulfills the shipment.**

## Hard rules (NEVER violate)
1. WhatsApp sends go **only** to `bot.json#whatsapp.group_id`.
2. **Never invent business facts** — prices/hours/policy only from `business.md`/`bot.json`; else defer to shop phone.
3. **Never approve compensation outside policy** (`bot.json#compensation_policy`, via `policy.mjs`). Doubt → human review.
4. **Authenticity gate** mandatory before any freshness approval.
5. **Log every case** to `data/cases/` via `cases.mjs`. Bot decides & records; human ships.
6. **Hebrew** to customers; English internal. Always reply, never `NO_REPLY`.
7. **Privacy** — customer data never leaves the system / never enters a web search.
8. **Self-modification needs a dev session** (skill/tools/secrets/channels/hooks/cron). Say so; never fake it.

## How to operate (shell)
```bash
cd /home/davidtobol2580/open_claw/workspace-pitzuchim
node --test tools/lib/*.test.mjs tools/*.test.mjs tools/hooks/**/*.test.mjs   # the suite (20 tests as of 2026-06-13)
node tools/cases.mjs stats
node tools/cases.mjs list "ממתין"
node tools/cases.mjs append '{"product":"גרעינים שחורים","complaint":"...","status":"ממתין לבדיקת אדם"}'
node tools/cases.mjs export-csv          # → data/cases/cases.csv for a human to review
node tools/sheet-sync.mjs ping           # health-check the Google Sheet webhook
node tools/sheet-sync.mjs backfill       # load chat history → Sheet "שיחות" tab (initial load / repair)
node tools/sheet-sync.mjs backfill-cases # load cases → Sheet "תיקים" tab
```

## Human monitoring (who said what + cases) — the dashboard
- **Local source of truth (always on, free):** `data/chat-log/<conversation>.jsonl` = full transcript (every
  message in/out, with `e164` + WhatsApp `name` per line after the identity-capture restart); `data/cases/cases.jsonl`.
- **Human view = one Google Sheet, two tabs** (`tools/apps-script-webhook.gs`): **"שיחות"** (live mirror of every
  message — who/direction/text/time, pushed by the `chat-log-pitzi` hook) + **"תיקים"** (cases, pushed by `cases.mjs`).
  Setup + restart steps in `ACTIVATION.md` Step 4. Live push is best-effort & non-blocking; `sheet-sync.mjs`
  backfills/repairs. In phase 2 (DMs), `dmScope:per-channel-peer` gives each customer their own conversation file,
  so "with whom" becomes one thread per customer automatically.
The `../openclaw` launcher wraps the CLI with Node 22 (nvm). Secret: `TAVILY_API_KEY` (web search, shared).

## ⚙️ Wiring status — LIVE (2026-06-13)
Wired into the shared gateway and verified up:
- **Group:** `120363000000000000@g.us` (David's test/demo group). Identified via the gateway log — David's
  "בדיקה"/"היי" inbound messages came from this id (the `directory groups list` only shows allowlisted groups,
  and `120363000000000000` is the POKER group — do NOT confuse them).
- **openclaw.json:** agent `pitzi` (opus-4-7) in `agents.list`; group in `channels.whatsapp...groups` with
  **`requireMention: false`** (so פיצי sees uncaptioned complaint photos); binding `{peer group 120363000000000000}`
  → pitzi as the FIRST binding (wins over main's `{channel:whatsapp}` fallback — which had been catching this
  group before wiring); hooks dir added to `hooks.internal.load.extraDirs`.
- **Hooks:** `ack-react-pitzi` + `chat-log-pitzi` both `ready`.
- **Backup:** `~/.openclaw/openclaw.json.bak-pre-pitzi-*` before the edits. Rollback per `ACTIVATION.md`.

Still pending (non-blocking): verify `business.md` facts with the owner; optional Google Sheet (Apps Script).
Phase-2 (separate number + customer DMs) still needs a dev session.

## ⚠️ Vendored-patch note
The OpenClaw runtime carries NON-STOCK vendored patches (ghost mode, harness de-registration) documented in
`../workspace/docs/RUNBOOK.md` — overwritten by `openclaw update`; re-apply after upgrades. They affect the
shared gateway, so they affect פיצי too.
