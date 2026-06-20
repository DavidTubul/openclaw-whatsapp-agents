# OpenClaw — WhatsApp AI Agents

A self-hosted, multi-agent runtime where **several independent AI assistants** live behind **one
gateway** and **one WhatsApp number** — each with its own persona, skill set, tools, data, and
WhatsApp group, fully isolated from the others. Every agent converses in Hebrew; the engineering is
designed so a single process can host many specialised bots safely and cheaply.

> Built by **David Tubul** as a personal platform for running domain-specific WhatsApp agents.
> The bots' real configuration, conversation data, and customer/contact details are **excluded from
> this repo by design** (see [Privacy & safety](#privacy--safety)). What's here is the architecture,
> code, personas, tools, and ops playbook.

---

## The idea in one diagram

```
                          WhatsApp  (one account / number)
                                     │
                          ┌──────────▼───────────┐
                          │    OpenClaw gateway   │   one process · one config
                          │  per-group routing +  │   (~/.openclaw/openclaw.json)
                          │  deterministic hooks   │
                          └──┬────────┬────────┬──┬─┘
            ┌────────────────┘        │        │  └────────────────┐
       ┌────▼─────┐          ┌────────▼──┐  ┌──▼────────┐    ┌─────▼──────┐
       │  Scotty  │          │   Digit   │  │  Dealer   │    │   Pitzi    │
       │ job scout│          │ real-estate│ │  poker    │    │ shop CS    │
       └──────────┘          └───────────┘  └───────────┘    └────────────┘
   workspace-jobscout/   workspace-realestate/  workspace-poker/  workspace-pitzuchim/

   Each agent = persona (system prompt) + a skill + deterministic tools + gateway hooks
                + its own data — isolated. Messages are routed to an agent by WhatsApp group.
```

A message arrives in a WhatsApp group → the gateway's **peer-level router** hands it to exactly one
agent → that agent answers from its own persona, knowledge, and tools. No agent can see or affect
another's data or behaviour.

## The agents

| Agent | Domain | What it does |
|-------|--------|--------------|
| 🤖 **Scotty** (`workspace-jobscout/`) | Multi-tenant job-search assistant | Daily cron scout over LinkedIn + Israeli job boards + Telegram, CV-matched per person; pushes matches to WhatsApp; tracks applications in a Google Sheet; syncs status from Gmail. **Multi-tenant**: an owner with the full pipeline + guests with search-only, gated by per-person capabilities. |
| 🏠 **Digit** (`workspace-realestate/`) | US turnkey real-estate advisor | Grounded Q&A on an investment process, the target market, and a specific deal — answers strictly from synced documents (never fabricates deal facts), with web-cited general guidance and a legal disclaimer. |
| 🎰 **Dealer** (`workspace-poker/`) | Home poker-game assistant | A deterministic ledger: buy-ins / cash-outs, end-of-night **settle-up** (minimal-transfer matching), lifetime leaderboard, game-night RSVP, and poker coaching. Every number comes from a tested CLI — the LLM never invents one. |
| 🥜 **Pitzi** (`workspace-pitzuchim/`) | Shop customer-service bot | FAQ + a **freshness-complaint workflow**: requests front/back product photos → verifies authenticity (vision) → reads expiry → decides eligibility per a deterministic policy → logs every case. The bot decides & records; a human ships. |

## Engineering highlights

- **Many agents, one runtime.** Per-WhatsApp-group routing + isolated `workspace-*/` dirs let one
  gateway host unrelated bots with no cross-talk. Adding an agent is a new workspace + a routing entry.
- **Deterministic tools + LLM, not LLM-guesses-numbers.** Anything involving money, ledgers, or
  records runs through unit-tested Node CLIs (e.g. the poker bank + greedy settle-up, the complaint
  policy engine, the job tracker). The LLM orchestrates and phrases; the tools are the source of truth.
- **Logic below the LLM via gateway hooks.** A deterministic 👍 acknowledgement and full chat-logging
  run as gateway hooks *beneath* the model — reliable regardless of what the LLM does that turn.
- **Session hygiene.** Per-agent systemd timers keep each conversational session small (size- and
  idle-gated resets) to sidestep a costly native compaction path, with continuity preserved through a
  regenerated `RECENT_CHAT.md` mirror. A watchdog detects a dead harness and self-heals.
- **Multi-tenant with capability gating.** Scotty serves an owner + guests from one group; per-person
  CV / sources / location filters; owner-only tools (Sheet/Gmail/Telegram) are gated so a guest can
  never reach another person's data.
- **Chat-driven self-extension, safely.** The owner can evolve a bot from chat; a harness wraps it in
  *snapshot → edit → verify (run the test suite) → auto-revert on failure → audit log* so a bad
  self-edit can't silently break a cron job.
- **Config / code separation.** Secrets, group IDs, and personal data live in git-ignored config &
  data the bots read at runtime; the committed personas and code are generic. `*.example.json`
  templates document every config so a fresh clone is reconfigurable.
- **Tested & operable.** 200+ unit tests across the deterministic logic, plus a `verify` harness
  (tests + syntax-check + config validation) and an ops **RUNBOOK** of root-caused failure modes.

## Tech stack

Node.js (ESM) · [Claude](https://www.anthropic.com/) via the OpenClaw agent runtime · WhatsApp ·
Google Sheets + Apps Script · Gmail (IMAP) · Telegram (MTProto) · Tavily search · rclone + Google
Drive · systemd timers · bash. Conversations are in Hebrew.

## Repo layout

```
open_claw/
├── README.md                 # this file
├── CLAUDE.md                 # repo-wide dev map (multi-agent overview)
├── openclaw                  # launcher (Node 22 via nvm → openclaw CLI)
├── docs/
│   ├── RUNBOOK.md            # ops + every root-caused failure mode
│   └── superpowers/          # design specs + implementation plans (the written record)
├── workspace-jobscout/       # 🤖 Scotty
├── workspace-realestate/     # 🏠 Digit
├── workspace-poker/          # 🎰 Dealer
├── workspace-pitzuchim/      # 🥜 Pitzi
└── workspace/                # a pristine starter-template agent
```

Every `workspace-*/` shares one shape: persona files injected into the system prompt
(`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`), a `skills/<skill>/`
directory, a `tools/` directory of executable `.mjs` tools (+ unit tests) and gateway hooks, a
git-ignored `data/` directory, and a `CLAUDE.md` dev map.

## Configuration

Each agent reads its live settings from a git-ignored `workspace-*/.config/*.json`. Committed
`*.example.json` templates show the exact schema — copy and fill in:

```bash
cp workspace-poker/.config/bot.example.json   workspace-poker/.config/bot.json
# …then set whatsapp.group_id, group_name, etc. Repeat per agent.
```

API keys (Tavily, Gmail, Telegram) and the Google service-account key are referenced by name and live
**outside the repo** (environment / `~/.openclaw/secrets/`) — they are never committed.

## Testing

```bash
# per workspace — the deterministic logic is unit-tested
cd workspace-poker     && node --test tools/lib/*.test.mjs tools/**/*.test.mjs
cd workspace-jobscout  && node tools/self-edit.mjs verify   # tests + syntax + config validation
```

## Privacy & safety

This repository is deliberately scrubbed for public release:

- **No secrets** — no API keys, tokens, OAuth credentials, webhooks, or sheet/drive identifiers.
- **No personal data** — phone numbers, emails, CVs, chat logs, customer records, photos, and the
  poker roster all live in git-ignored `data/` / `.config/` / `people/` and never enter the repo.
- **Client businesses are anonymised** — the customer-service and real-estate agents were built for
  real third-party businesses; their brand names and customer details are generalised here.

The architecture is the deliverable. The bots run from their own (git-ignored) configuration and data.

---

© 2026 David Tubul. Released under the [MIT License](LICENSE).
