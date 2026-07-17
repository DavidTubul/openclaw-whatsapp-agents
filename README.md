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
       │  Scotty  │          │   Digit   │  │  Dealer   │    │   Zorro    │
       │ job scout│          │ real-estate│ │  poker    │    │ quit-smoke │
       └──────────┘          └───────────┘  └───────────┘    └────────────┘
   workspace-jobscout/   workspace-realestate/  workspace-poker/  workspace-quitsmoke/

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
| ⚔️ **Zorro** (`workspace-quitsmoke/`) | Tough-love quit-smoking coach | A sharp, sarcastic "bad-cop" coach: a daily morning harm-fact/story (sourced WHO/CDC, optional image), a smoke-free **streak "justice table"** (tested CLI, optional Google-Sheet mirror) with a daily check-in and leaderboard, and grounded Q&A — drops the edge for medical/distress and points to professional help. Numbers come from the tool, never invented. |

> **Archived:** 🥜 **Pitzi** — a shop customer-service demo bot (FAQ + freshness-complaint workflow)
> was **retired on 2026-07-17**. Its code and data are preserved under `archive/workspace-pitzuchim/`
> (see that dir's `ARCHIVED.md`); it is no longer wired into the running gateway.

## Engineering highlights

- **Many agents, one runtime.** Per-WhatsApp-group routing + isolated `workspace-*/` dirs let one
  gateway host unrelated bots with no cross-talk. Adding an agent is a new workspace + a routing entry.
- **Deterministic tools + LLM, not LLM-guesses-numbers.** Anything involving money, ledgers, or
  records runs through unit-tested Node CLIs (e.g. the poker bank + greedy settle-up, the complaint
  policy engine, the job tracker). The LLM orchestrates and phrases; the tools are the source of truth.
- **Logic below the LLM via gateway hooks.** A deterministic 👍 acknowledgement, full chat-logging, and
  the group-reply policy run as gateway hooks *beneath* the model — reliable regardless of what the LLM
  does that turn. The hooks are **shared**: a single set under `shared/hooks/` serves every live bot and
  resolves which agent owns each message by its group via the central registry.
- **Registry-driven shared infra.** `shared/registry.json` is the single source of truth for every live
  bot (agent id, workspace dir, group ids, persona, owner, session-hygiene params); `shared/lib/` holds the
  unit-tested engines (hooks, reply-policy, self-edit, session-hygiene) that the per-agent tools are
  thin shims over.
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
├── shared/                   # registry + shared infra for all live bots
│   ├── registry.json         # single source of truth (agents, groups, persona, hygiene)
│   ├── lib/                  # unit-tested engines (registry, hooks, reply-policy, self-edit, hygiene)
│   ├── hooks/               # the 3 shared gateway hooks (ack-react, chat-log, group-reply-policy)
│   ├── bin/                 # self-edit multi-agent CLI entry
│   └── tools/               # session-hygiene multi-agent CLI entry
├── workspace-jobscout/       # 🤖 Scotty
├── workspace-realestate/     # 🏠 Digit
├── workspace-poker/          # 🎰 Dealer
├── workspace-quitsmoke/      # ⚔️ Zorro
└── archive/
    └── workspace-pitzuchim/  # 🥜 Pitzi — ARCHIVED 2026-07-17 (retired; code kept for revival)
```

Every `workspace-*/` shares one shape: persona files injected into the system prompt
(`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`), a `skills/<skill>/`
directory, a `tools/` directory of executable `.mjs` tools (+ unit tests), a
git-ignored `data/` directory, and a `CLAUDE.md` dev map. The gateway hooks are no longer per-workspace
— all live bots share the single set under `shared/hooks/`.

## Configuration

Each agent reads its live settings from a git-ignored `workspace-*/.config/*.json`. Committed
`*.example.json` templates show the exact schema — copy and fill in:

```bash
cp workspace-poker/.config/bot.example.json   workspace-poker/.config/bot.json
# …then fill in the agent's domain settings. Repeat per agent.
# (Group wiring is NOT here — it lives in shared/registry.json; see "add a bot" below.)
```

API keys (Tavily, Gmail, Telegram) and the Google service-account key are referenced by name and live
**outside the repo** (environment / `~/.openclaw/secrets/`) — they are never committed.

## Adding a new agent

Each agent is a self-contained `workspace-<domain>/` plus a few entries in the shared gateway config.
The fastest path is to **clone an existing peer** (Zorro is the cleanest template) and rename:

1. **Create the workspace.** Copy a peer dir to `workspace-<domain>/` and edit the persona files
   (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`) — these are the only
   files injected into the system prompt, so every always-on rule lives here. Write the skill under
   `skills/<skill>/` (a `SKILL.md` + `prompt-*.md` flows + a grounded `knowledge.md`).
2. **Register it & reuse the shared infra.** Everything is driven by `shared/registry.json` (registry v2).
   Add **two** things: the group to the top-level `groups` map (symbolic name → `{jid, label,
   requireMention}`), and one agent entry (agent id, workspace dir, `identity {name, emoji}`, the symbolic
   `primaryGroup`/`groups` refs, `cronTargets`, and optional `sessionHygiene`/`chatLog` blocks). The three
   gateway hooks (`ack-react` 👍, `chat-log` continuity, `group-reply-policy`) and the `self-edit` /
   `session-hygiene` engines are all shared and registry-driven — you do **not** copy them per-bot. For a
   bot that wants its own `tools/self-edit.mjs` / `tools/session-hygiene.mjs` invocation path, drop in a
   one-line thin shim that delegates to `shared/` with its agent id (see the peers). Any domain-specific
   tool goes in the new `tools/` (+ its `lib/` pure logic). `node --test` must stay green. (`bot.json`
   carries domain config only — it no longer holds any WhatsApp/session-hygiene wiring.)
3. **Get the group's `group_id`.** Add the **bot's own WhatsApp number** to the group, send a message,
   and read the `…@g.us` id from the gateway log
   (`journalctl --user -u openclaw-gateway.service --since "-5 min" | grep '@g.us'`).
   ⚠️ The #1 gotcha: if the bot number isn't a *member* of the group, nothing arrives and the log stays
   empty — that's not complexity, just add the number first. (Full method + fallbacks in `docs/RUNBOOK.md`.)
4. **Derive the gateway config — never hand-edit `~/.openclaw/openclaw.json`.** With the group + agent
   entries in `shared/registry.json` (step 2), run `node shared/tools/registry-sync.mjs --check` (review
   the drift), then `--apply`. That writes the `agents.list[]` entry (with an **explicit Hebrew
   `mentionPatterns`** — the auto-derived ASCII regex never matches Hebrew), the allowlist entry under
   `channels.whatsapp.accounts.default.groups`, and **prepends** the `bindings[]` route (peer match wins
   over the default catch-all) — atomically, with a timestamped backup, and it also sets each cron's
   `delivery.to`. No `hooks.*` edit is needed: `hooks.internal.load.extraDirs` already points at the shared
   `shared/hooks` dir, so the new bot's hooks fire the moment it's in the registry. Then a clean
   `openclaw gateway restart` while chat is idle.
5. **(Optional) a daily cron** via `openclaw cron add …` and a per-agent `session-hygiene` systemd timer.

Each agent ships a step-by-step `ACTIVATION.md` with the exact snippets (see
[`workspace-quitsmoke/ACTIVATION.md`](workspace-quitsmoke/ACTIVATION.md)).

> **Bots only ever touch the groups you configure.** `groupPolicy: "allowlist"` means the gateway
> processes messages **only** from groups explicitly listed in the config; every other group — including
> any private group the bot's number happens to be a member of — is **silently ignored**. Combined with
> per-group `bindings[]` and `requireMention`, an agent can never reply in, or send to, a group you
> didn't wire. The daily cron likewise sends only to its one configured `--to <group_id>`.

## Testing

```bash
# shared infra — registry, hooks, reply-policy, self-edit, session-hygiene
cd shared              && node --test lib/*.test.mjs tools/*.test.mjs
# per workspace — the domain-specific deterministic logic is unit-tested
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
