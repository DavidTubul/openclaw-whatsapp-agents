> 🗄️ **ARCHIVED 2026-07-17 — bot retired, not in active use.** Runtime wiring removed; code/data kept for revival. See [`ARCHIVED.md`](ARCHIVED.md). Everything below is preserved as-is from when it was live.

# פיצי — חנות הפיצוחים Customer-Service Bot (read this first)

> Auto-loaded each session so any agent understands the whole project without re-exploring. Last reviewed: 2026-07-13.
> Created 2026-06-13. **Status: WIRED to the test/demo group since 2026-06-13**. ⚠️ 2026-07-15: flipped to
> `requireMention:true` per David's blanket "bots answer only when name-called" rule — פיצי now answers only
> when addressed as "פיצי" (uncaptioned complaint photos still ARRIVE + are archived via chat-log, but get no
> reply until someone says the name; revert = one `requireMention` line in openclaw.json + gateway restart);
> production wiring / phase-2 (separate number + customer DMs) pending — see "⚙️ Wiring status" below + `ACTIVATION.md`.

> ⚠️ **What the conversational agent actually loads:** only the 6 persona files (AGENTS.md, SOUL.md,
> IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md) are injected. So any always-on rule lives in **`AGENTS.md`**
> (persona, always-reply, knowledge-file pointers, complaint routing, the 📸 photo-reading instruction).
> Full explanation → `../CLAUDE.md`.

## What this is

**פיצי (Pitzi) 🥜** is the **customer-service bot of חנות הפיצוחים** — a nuts/seeds shop. It answers
**customers** in Hebrew over WhatsApp:
1. **Business info** — hours, address, phone, delivery, payment, kashrut (grounded in `skills/customer-service/business.md`).
2. **FAQ** — products, prices, returns, gift packs, event orders.
3. **Complaints — the core flow**: the **freshness complaint** (`prompt-complaint.md`) — request front+back
   bag photos → verify authenticity (vision) → read expiry → decide per policy → entitle to **2 replacement
   packages** when eligible → **log every case** to a human-verifiable tracker. A human ships; the bot decides & records.

Conversational only (no cron). Wake-word **"פיצי"** — but the demo group is wired `requireMention:false`
(so פיצי also sees uncaptioned complaint photos).

> **Relationship to the other agents:** פיצי is a **completely separate agent**; five bots share only the
> OpenClaw runtime — see `../CLAUDE.md`. Do NOT touch the sibling workspaces.

## Deployment phases (per David, 2026-06-13)
- **Phase 1 (now — MVP, LIVE since 2026-06-13):** a dedicated WhatsApp **test/demo group** on the existing number,
  `requireMention=false` (so uncaptioned complaint photos arrive), wake-word "פיצי". For David to test + demo to the business.
- **Phase 2 (future):** a **separate WhatsApp number** for the business + answering **customer DMs**. Requires a
  dev session: connect a new WhatsApp account/channel in the gateway, set `dmPolicy:"enabled"` (currently the
  account `dmPolicy:"disabled"`), and adjust always-reply for DMs (already covered in AGENTS.md). NOT doable from chat.

## Layout
```
workspace-pitzuchim/
├── CLAUDE.md / IDENTITY.md / SOUL.md / AGENTS.md / USER.md / TOOLS.md / HEARTBEAT.md
├── RECENT_CHAT.md                  # recent conversation (shared chat-log hook) — continuity
├── ACTIVATION.md                   # 🔌 the wiring checklist to take it live (group id, openclaw.json, Sheet)
├── .config/bot.json                # DOMAIN config only: compensation_policy, sheet, media dir. Group id + bot {name,emoji,mention} + session-hygiene now live in shared/registry.json (registry-v2 refactor)
├── skills/customer-service/
│   ├── SKILL.md                    # entry, mode routing, hard rules, tools
│   ├── prompt-qa.md                # business/FAQ Q&A flow (grounded in business.md)
│   ├── prompt-complaint.md         # 🥜 the freshness-complaint workflow (photos→auth→policy→log→reply)
│   ├── router.md                   # intent table
│   └── business.md                 # the shop's facts (⚠️ web-sourced, UNVERIFIED — David must confirm)
├── tools/
│   ├── cases.mjs                   # case/complaint ledger CLI (append/list/read/update/claims/stats/export-csv)
│   ├── cases.test.mjs
│   ├── sheet-sync.mjs              # Google Sheet sync (ping/backfill/backfill-cases)
│   ├── lib/policy.mjs              # deterministic compensation decision (expiry math + policy) — unit-tested
│   ├── lib/policy.test.mjs
│   ├── apps-script-webhook.gs      # Apps Script for the optional Google Sheet tracker
│   └── package.json                # { "type": "module" }
│                                   # gateway hooks are SHARED (shared/hooks/), resolve pitzi by group
│                                   # via the registry — NOT a per-workspace tools/hooks dir (deleted 2026-06-26)
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
1. WhatsApp sends go **only** to the configured group (the `pitzi` agent's group in `shared/registry.json`).
2. **Never invent business facts** — prices/hours/policy only from `business.md`/`bot.json`; else defer to shop phone.
3. **Never approve compensation outside policy** (`bot.json#compensation_policy`, via `policy.mjs`). Doubt → human review.
4. **Authenticity gate** mandatory before any freshness approval.
5. **Log every case** to `data/cases/` via `cases.mjs`. Bot decides & records; human ships.
6. **Hebrew** to customers; English internal. Always reply, never `NO_REPLY`.
7. **Privacy** — customer data never leaves the system / never enters a web search.
8. **Self-modification needs a dev session** (skill/tools/secrets/channels/hooks/cron). Say so; never fake it.

## How to operate (shell)
```bash
cd ~/open_claw/workspace-pitzuchim
node --test tools/lib/*.test.mjs tools/*.test.mjs   # pitzi's domain logic (cases + policy)
# the shared hooks/engines are tested from shared/: (cd ../shared && node --test lib/*.test.mjs tools/*.test.mjs)
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
  message — who/direction/text/time, pushed by the shared `chat-log` hook) + **"תיקים"** (cases, pushed by `cases.mjs`).
  Setup + restart steps in `ACTIVATION.md` Step 4. Live push is best-effort & non-blocking; `sheet-sync.mjs`
  backfills/repairs. In phase 2 (DMs), `dmScope:per-channel-peer` gives each customer their own conversation file,
  so "with whom" becomes one thread per customer automatically.
The `../openclaw` launcher wraps the CLI with Node 22 (nvm). Secret: `TAVILY_API_KEY` (web search, shared).

## ⚙️ Wiring status — LIVE (2026-06-13)
Wired into the shared gateway and verified up:
- **Group:** `120363000000000000@g.us` (David's test/demo group). Identified via the gateway log — David's
  "בדיקה"/"היי" inbound messages came from this id (the `directory groups list` only shows allowlisted groups,
  and `120363000000000000` is the POKER group — do NOT confuse them).
- **openclaw.json (all DERIVED from `shared/registry.json` via registry-sync):** agent `pitzi` (`anthropic/claude-sonnet-5`) in `agents.list`; group in `channels.whatsapp...groups` with
  **`requireMention: false`** (so פיצי sees uncaptioned complaint photos); binding `{peer group 120363000000000000}`
  → pitzi as the FIRST binding (wins over main's `{channel:whatsapp}` fallback — which had been catching this
  group before wiring); `hooks.internal.load.extraDirs` points at the single shared `shared/hooks` dir.
- **Hooks:** the SHARED `ack-react` + `chat-log` (+ `group-reply-policy`) packs serve pitzi, resolving it
  by its group jid via `shared/registry.json` (the old per-workspace `*-pitzi` copies were removed in the
  2026-06-26 shared-infra refactor).
- **Backup:** `~/.openclaw/openclaw.json.bak-pre-pitzi-*` before the edits. Rollback per `ACTIVATION.md`.

Still pending (non-blocking): verify `business.md` facts with the owner; optional Google Sheet (Apps Script).
Phase-2 (separate number + customer DMs) still needs a dev session.

## ⚠️ Vendored-patch note
NON-STOCK gateway patches are documented in `../docs/RUNBOOK.md`; `openclaw update` wipes them.
Re-apply after upgrades — they affect the shared gateway, so פיצי too.
