# OpenClaw — Multi-Agent Repo Map (read this first)

> Auto-loaded into any Claude Code dev session whose cwd is this repo root. It exists so that
> between one prompt and the next, you understand the *whole* repo — **not one bot, but several** —
> without re-exploring from scratch. Last reviewed: 2026-06-15.

## What this repo is

**OpenClaw** is a self-hosted personal AI-agent runtime (one gateway, WhatsApp-first). This repo
hosts **several independent agents (bots)**, each living in its own `workspace-<domain>/` directory
with its own persona, skill, tools, data, and WhatsApp group. They share **one** OpenClaw gateway
process and **one** config file (`~/.openclaw/openclaw.json`), but are otherwise isolated.

> ⚠️ **When you get a prompt, first figure out WHICH agent it's about** (the table below). Then read
> that agent's own `workspace-*/CLAUDE.md` — that's the deep map. Don't assume "the project" = one bot.

## The agents

| Agent | Persona | Domain | Workspace dir | Deep map | Status |
|-------|---------|--------|---------------|----------|--------|
| **Scotty** סקוטי 🤖 | job-search assistant | multi-tenant job scout (David + guests) | `workspace-jobscout/` | [`workspace-jobscout/CLAUDE.md`](workspace-jobscout/CLAUDE.md) | **live** — daily 08:00 cron + Q&A |
| **דיגיט** Digit 🏠 | sales/advisor bot of השקעות דיגיט | US turnkey real-estate investing (Toledo BRRRR) | `workspace-realestate/` | [`workspace-realestate/CLAUDE.md`](workspace-realestate/CLAUDE.md) | **live** |
| **דילר** Dealer 🎰 | home poker-game assistant | buy-ins / settle-up / leaderboard / coaching | `workspace-poker/` | [`workspace-poker/CLAUDE.md`](workspace-poker/CLAUDE.md) | built; wiring pending group_id |
| **פיצי** Pitzi 🥜 | customer-service bot of חנות הפיצוחים | nuts-shop FAQ + freshness-complaint workflow | `workspace-pitzuchim/` | [`workspace-pitzuchim/CLAUDE.md`](workspace-pitzuchim/CLAUDE.md) + [`ACTIVATION.md`](workspace-pitzuchim/ACTIVATION.md) | built, **not yet wired live** |

Each agent answers in **Hebrew**, lives in **one WhatsApp group**, and (except Scotty's owner path)
responds only when addressed by its wake-word (`requireMention`). Scotty is the gateway **default
agent** (`agent: main`); the other three are explicit per-agent entries.

## Repo layout

```
open_claw/
├── CLAUDE.md                     # ← you are here: repo-wide multi-agent map
├── openclaw                      # launcher: nvm use 22 → exec openclaw CLI (shared by all agents)
├── docs/
│   ├── RUNBOOK.md                # ops + every root-caused failure mode (shared infra) — read when debugging
│   └── superpowers/              # historical design specs + implementation plans (a record; paths there are pre-rename)
├── workspace-jobscout/           # 🤖 Scotty — job scout       (see its CLAUDE.md)
├── workspace-realestate/         # 🏠 דיגיט — real-estate       (see its CLAUDE.md)
├── workspace-poker/              # 🎰 דילר — poker              (see its CLAUDE.md)
└── workspace-pitzuchim/          # 🥜 פיצי — nuts-shop CS       (see its CLAUDE.md + ACTIVATION.md)
```

Every `workspace-*/` follows the same internal shape: `CLAUDE.md` (dev map, humans/dev only),
`AGENTS.md`/`SOUL.md`/`IDENTITY.md`/`USER.md`/`TOOLS.md`/`HEARTBEAT.md` (**the files actually injected
into the bot's system prompt**), a `skills/<skill>/` dir, a `tools/` dir of `.mjs` executables, and a
`data/` dir. `RECENT_CHAT.md` (when present) is the conversational-continuity mirror.

## Shared infrastructure (cross-agent — applies to all four)

- **One gateway, one config:** all four run under the single OpenClaw gateway, configured in
  `~/.openclaw/openclaw.json` (`agents.defaults` = Scotty/`main`; `agents.<id>` overrides
  `workspace` for the other three; `hooks.load.extraDirs` lists each agent's `tools/hooks`).
  Editing `channels.whatsapp.*` or an agent's `workspace` path needs a **clean
  `openclaw gateway restart` while chat is idle**; agent/skill/prompt **file** edits hot-reload fine.
- **Launcher:** `./openclaw` wraps the CLI with Node 22 (via nvm).
- **Auth:** the user's **Claude Max-5x subscription via OAuth** (`~/.claude/.credentials.json`) —
  rate-limit bound, not per-token. Conversational sessions run `claude -p` (sonnet, effort medium/high);
  cron jobs carry their own `model`/`thinking`.
- **What the bot actually loads (verified):** OpenClaw injects ONLY `AGENTS.md, SOUL.md, IDENTITY.md,
  USER.md, TOOLS.md, HEARTBEAT.md` into the system prompt. It does **NOT** auto-load `CLAUDE.md` or
  `SKILL.md`/`prompt-*.md` (read on-demand). **Any always-on rule belongs in `AGENTS.md`.**
  The `CLAUDE.md` files (this one and each agent's) are dev maps for humans / dev sessions.
- **Operations & failure modes → [`docs/RUNBOOK.md`](docs/RUNBOOK.md)** (ack-react hook, session
  hygiene, ghost mode, harness de-registration, compaction failures, shared-host reboots).
- ⚠️ **NON-STOCK vendored patches** (ghost mode + harness de-registration) are overwritten by
  `npm i -g openclaw` / `openclaw update` — re-apply from `docs/RUNBOOK.md` after any upgrade.
- ⚠️ **Shared host:** another sudo user can reboot the box and take all agents down; it auto-recovers
  and `boot-notify.mjs` posts a reboot notice. (See user-memory.)

## Working in this repo

1. **Identify the agent** from the prompt (wake-word סקוטי/דיגיט/דילר/פיצי, domain, or group). When in
   doubt, ask — don't guess which bot.
2. **Read that agent's `workspace-*/CLAUDE.md`** for its pipeline, tools, hard rules, and history.
3. For **cross-cutting / infra / failure** questions, read `docs/RUNBOOK.md`.
4. **Never guess a messaging target** — each agent sends only to its own configured group (see
   user-memory). Sends, sheet writes, and any outward action are scoped per-agent.
