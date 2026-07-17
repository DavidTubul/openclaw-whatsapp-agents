# OpenClaw — Multi-Agent Repo Map (read this first)

> Auto-loaded into any Claude Code dev session whose cwd is this repo root. It exists so that
> between one prompt and the next, you understand the *whole* repo — **not one bot, but several** —
> without re-exploring from scratch. Last reviewed: 2026-07-17.
>
> Cross-cutting plumbing lives in the ONE registry-driven [`shared/`](shared/) package (`shared/registry.json`) — see **Shared infrastructure**.

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
| **דיגיט** Digit 🏠 | sales/advisor bot of השקעות דיגיט | US turnkey real-estate investing (Toledo BRRRR) | `workspace-realestate/` | [`workspace-realestate/CLAUDE.md`](workspace-realestate/CLAUDE.md) | **live** — 2 answering groups + 1 listen-only group (via `listener`) |
| **מאזין** listener 👂 | silent ingest-only shadow agent (haiku) | listen-only groups: never answers, feeds the owning bot's chat-log via `listen-export` | `workspace-listener/` | see "Listen-only group mode" below | **live** since 2026-07-14 (serves digit's listen-only group) |
| **דילר / דאוס** Dealer 🎰 | home poker-game assistant | buy-ins / settle-up / leaderboard / coaching + daily Dor lesson/quiz/roast | `workspace-poker/` | [`workspace-poker/CLAUDE.md`](workspace-poker/CLAUDE.md) | **live** — wired + 3 daily crons |
| **זורו** Zorro ⚔️ | tough-love quit-smoking coach | morning harm-fact/story + smoke-free streak "justice table" + daily check-in + Q&A | `workspace-quitsmoke/` | [`workspace-quitsmoke/CLAUDE.md`](workspace-quitsmoke/CLAUDE.md) + [`ACTIVATION.md`](workspace-quitsmoke/ACTIVATION.md) | **live** (conversational wired 2026-06-26; daily cron optional) |

> **Archived agents:** 🥜 **פיצי** Pitzi (nuts-shop customer-service — FAQ + freshness-complaint workflow) was **retired 2026-07-17**: runtime wiring removed (registry entry flagged `archived:true` → no allowlist/binding/agents.list/cron), code + data kept in [`archive/workspace-pitzuchim/`](archive/workspace-pitzuchim/) (revival steps in its `ARCHIVED.md`).

Each agent answers in **Hebrew**, lives in **one WhatsApp group**, and (except Scotty's owner path)
responds only when addressed by its wake-word (`requireMention`). Scotty is the gateway **default
agent** (`agent: main`); the other live answering agents (digit, poker, zorro) + the silent `listener`
are explicit per-agent entries. (**4 live answering bots** since פיצי was archived 2026-07-17.)

## Repo layout

```
open_claw/
├── CLAUDE.md                     # ← you are here: repo-wide multi-agent map
├── openclaw                      # launcher: nvm use 22 → exec openclaw CLI (shared by all agents)
├── shared/                       # 🧩 ONE parameterized infra package for ALL bots (registry-driven)
│   ├── registry.json             #   registry v2 — SINGLE source of truth for ALL WhatsApp wiring: top-level groups map + per-agent groups/identity/cronTargets (gitignored; committed template: registry.example.json). openclaw.json is DERIVED from it via registry-sync
│   ├── lib/                      #   agent-registry, reply-policy, chat-log, ack-react, self-edit, session-hygiene, cron-contract, cron-feed, time, gmail, jsonl, paths, fs-atomic (+tests)
│   ├── tools/registry-sync.mjs   #   reconcile registry.json → openclaw.json (allowlist+bindings+agents.list identity/mentionPatterns/workspace) + cron delivery targets: --check (drift, exit 0/1) / --json / --apply (backups → shared/backups/registry-sync/, atomic patch, prints restart reminder)
│   ├── hooks/                    #   the 4 shared internal hooks (ack-react, chat-log, group-memory, group-reply-policy)
│   ├── bin/self-edit.mjs         #   multi-agent self-edit CLI  (runForAgent(id) / --agent <id>)
│   ├── tools/session-hygiene.mjs #   multi-agent session-hygiene CLI (--agent <id> / --all)
│   ├── tools/cron-feed.mjs       #   deterministic content-feed sender for cron (--agent <id> --feed <name>)
│   ├── tools/reflect.mjs         #   daily group-memory rewrite (--all → group-notes.md via openclaw-reflect timer)
│   ├── tools/listen-export.mjs   #   listen-only groups: listener sessions → owning bot's chat-log (openclaw-listen-export timer, 15 min)
│   ├── tools/gateway-watchdog.sh #   multi-agent watchdog (session/compaction health checks)
│   └── tools/boot-notify.mjs     #   posts a reboot notice after shared-host recovery
├── docs/
│   ├── RUNBOOK.md                # ops + every root-caused failure mode (shared infra) — read when debugging
│   └── superpowers/              # historical design specs + implementation plans (a record; paths there are pre-rename)
├── workspace-jobscout/           # 🤖 Scotty — job scout       (see its CLAUDE.md)
├── workspace-realestate/         # 🏠 דיגיט — real-estate       (see its CLAUDE.md)
├── workspace-poker/              # 🎰 דילר — poker              (see its CLAUDE.md)
├── workspace-quitsmoke/          # ⚔️ זורו — quit-smoking coach (see its CLAUDE.md + ACTIVATION.md)
└── archive/
    └── workspace-pitzuchim/      # 🥜 פיצי — nuts-shop CS       ARCHIVED 2026-07-17 (retired; code kept, see ARCHIVED.md)
```

Every `workspace-*/` follows the same internal shape: `CLAUDE.md` (dev map, humans/dev only),
`AGENTS.md`/`SOUL.md`/`IDENTITY.md`/`USER.md`/`TOOLS.md`/`HEARTBEAT.md` (**the files actually injected
into the bot's system prompt**), a `skills/<skill>/` dir, a `tools/` dir (domain `.mjs` executables +
thin shims over `shared/` for session-hygiene/self-edit), and a `data/` dir. `RECENT_CHAT.md` (when
present) is the conversational-continuity mirror. **Cross-cutting plumbing is no longer per-workspace** —
hooks live in `shared/hooks/`, shared logic in `shared/lib/`, all keyed off `shared/registry.json`.

## Shared infrastructure (cross-agent — applies to all live agents)

- **One gateway, one config:** all live agents run under the single OpenClaw gateway, configured in
  `~/.openclaw/openclaw.json` (`agents.defaults` = Scotty/`main`; `agents.<id>` overrides
  `workspace` for the others; `hooks.internal.load.extraDirs` now lists a **single** dir,
  `shared/hooks` — one set of hooks serves every bot, no per-workspace hook dirs).
  Editing `channels.whatsapp.*`, an agent's `workspace` path, or `hooks.*` needs a **clean
  gateway restart while chat is idle** (`systemctl --user restart openclaw-gateway.service`, or
  `openclaw gateway restart`); agent/skill/prompt **file** edits hot-reload fine.
- **🧩 Shared infra package (`shared/`, registry-driven):** the single source of truth for who each
  bot is AND for **all WhatsApp wiring** is **`shared/registry.json`** — now **registry v2**
  (gitignored — real ids/PII; the committed template is **`shared/registry.example.json`**),
  loaded/indexed by `shared/lib/agent-registry.mjs` (`getAgent(id)`, `getAgentByGroup(jid)` — every
  wiring reader goes through this lib). **v2 shape:** a top-level `groups` map (symbolic name →
  `{jid, label, requireMention, listenOnly?, routeAgentId?, systemPrompt?}`); `owner {e164,label}`
  stored ONCE at top level; each agent carries `identity {name, emoji, mentionPatterns?}`, **symbolic**
  `primaryGroup`/`groups` (resolved to jids by the loader), `listenGroups`, `cronTargets`
  (per-cron-job symbolic target, `default`→primary), and optional `chatLog.labels`/`sessionHygiene`/
  `selfEdit`/`ackReact` blocks. The silent **`listener`** agent is included (empty `groups`, unmatchable
  `mentionPattern`). **openclaw.json is DERIVED, not hand-edited:** `shared/tools/registry-sync.mjs`
  reconciles registry.json → the live `channels.whatsapp` allowlist, `bindings`, `agents.list`
  identity/mentionPatterns/workspace, **and cron `delivery.to` targets**. Workflow: `--check` reports
  drift (exit 0/1), `--json` machine-readable, `--apply` writes timestamped backups of both files to
  `shared/backups/registry-sync/` (pruned to 20), patches openclaw.json atomically, sets cron targets
  via `openclaw cron edit --to`, and prints a gateway-restart reminder only when openclaw.json changed.
  **Moving an agent to a new group = edit registry.json (group jid or the agent's `groups` ref) →
  `registry-sync --apply` → gateway restart while idle** (cron targets follow automatically — this
  replaces the old error-prone "edit 4 places by hand" recipe, which missed crons and sent poker's
  2026-07-17 morning lesson to its OLD group). **Four**
  shared internal hooks in `shared/hooks/` (all fire on registry-resolved agents, never throw):
  **`ack-react`** (👍 ack on messages **addressed to the bot** (wake-word) — the 4 live answering agents + listener, registry-scoped
  groups only; listen-only groups excluded (they're absent from the registry `groupIds`). Registry-driven per
  agent via an optional `ackReact` block `{enabled?(def true), scope?:"mentions"(def)|"all"}`. This is the ONE
  source of group 👍s: OpenClaw's native `channels.whatsapp.ackReaction.group` stays `"never"` (with
  `requireMention:false` the native "mentions" scope acked EVERY message, incl. in listen-only groups); DM ack
  stays native), **`chat-log`**
  (mirror → `data/chat-log/<group>.jsonl` + **media archive**: every inbound file/photo/voice-note is copied
  to the owning bot's `data/media/<group>/` — keep-everything, no TTL — and referenced from the jsonl; voice
  notes get a Hebrew `.transcript.txt` via faster-whisper-small through the `openclaw-transcribe.timer`
  (15 min) + `shared/tools/transcribe-media.mjs`; `listen-export` carries media the same way +
  `RECENT_CHAT.md` + `last-inbound.json`), **`group-reply-policy`** (injects the group-reply policy at
  `agent:bootstrap` from the ONE source `shared/lib/reply-policy.mjs` — "answer all bundled messages
  in order / **@-tag by phone anyone you address** / don't double-send", once not inline ×5), and
  **`group-memory`** (injects each bot's LEARNED `data/memory/group-notes.md` so it knows the people +
  humor; rewritten daily by `shared/tools/reflect.mjs --all` via the `openclaw-reflect` timer →
  `shared/lib/group-memory.mjs`). Conversational sequencing is gated by `messages.queue` (mode
  `collect`) + `messages.inbound.debounceMs` in `openclaw.json` — each message answered in order,
  same session, building on the last (queue mode is `collect`). `session-hygiene` and `self-edit` are likewise shared libs with multi-agent CLIs
  (`shared/tools/session-hygiene.mjs --agent <id>|--all`, `shared/bin/self-edit.mjs` `runForAgent(id)`);
  each workspace keeps a thin shim at the old path so systemd units/skill prompts keep working.
  Tests: `cd shared && node --test` (whole suite green).
- **🕒 Shared CRON architecture (`shared/lib/cron-contract.mjs` + `shared/lib`/`tools/cron-feed.mjs`, 2026-06-29):**
  `delivery.mode: announce` posts the cron agent's FINAL turn text **verbatim**, so any cron that makes the
  agent *compose+log+deliver* ships a status line ("…delivered and logged" / "נשלח ✅") and the real content
  never arrives. **Every cron agent follows ONE of two shapes:** (a) DYNAMIC content (the agent writes —
  scout, weekly-review, zorro morning-kick, **all 3 poker crons**: infinite/non-repeating/counting-up lesson,
  evening quiz on that lesson, member-rotation roast) → a tool OWNS the state (syllabus position, rotation,
  bookkeeping) and the cron body ends with `withContract()` (the single-source announce contract); the agent
  only writes prose. (b) FIXED, pre-authored content → a feed JSON at `workspace-*/data/feeds/<name>.json`
  walked by `cron-feed.mjs` (prints the next item verbatim — no LLM in the content path), pointed at by
  `feedEchoMessage()`. **Never** ask a cron agent to compose-and-log in one turn. ⚠️ When changing a
  schedule, pass `--tz Asia/Jerusalem` (a bare `--cron` resets TZ to the host's UTC). Full detail + migration
  record → [`docs/RUNBOOK.md`](docs/RUNBOOK.md) "Shared cron architecture".
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
- ⚠️ **NON-STOCK vendored patches** (1: ghost mode; 2: harness de-registration — now STOCK, contingent on
  the `cliBackends` config key; 3: per-conversation turn serialization — fixes the cross-sender "only the
  last person answered" race; **4: per-inbound `message:received` emission** in the WhatsApp extension
  monitor — 2026.7.1 dropped it, silencing the ack-react/chat-log hooks for every inbound; marker
  `[inbound-hook-emit]`) all live in the WhatsApp monitor bundle (`…/extensions/whatsapp/dist/monitor-*.js`,
  currently `monitor-DD8bXohk.js` — renamed per build) and are overwritten by `npm i -g openclaw` /
  `openclaw update` / plugin reinstall — **re-apply patches 1/3/4 from `docs/RUNBOOK.md` after any upgrade**
  (watchdog CHECK E sentinel-greps all three markers).
- ⚠️ **Shared host:** another sudo user can reboot the box and take all agents down; it auto-recovers
  and `boot-notify.mjs` posts a reboot notice. (See user-memory.)

## Working in this repo

1. **Identify the agent** from the prompt (wake-word סקוטי/דיגיט/דאוס/פיצי/זורו, domain, or group). When in
   doubt, ask — don't guess which bot.
2. **Read that agent's `workspace-*/CLAUDE.md`** for its pipeline, tools, hard rules, and history.
3. **Architecture-first, cross-agent by default (for EVERY task).** Before implementing, decide the
   architecturally-correct home: is this **domain-specific** (lives in `workspace-<x>/`) or
   **cross-cutting** (belongs in the registry-driven `shared/` package — hooks, reply-policy,
   group-memory, session-hygiene, self-edit, cron-contract/feed, keyed off `shared/registry.json`)?
   Then **proactively assess whether the change is relevant to the OTHER agents too — even when the
   prompt only names one.** If it's cross-cutting, say so and propose applying it to all relevant
   bots; don't silently scope a shared-infra fix to a single workspace (that re-creates the
   hand-copied sprawl the 2026-06-27 refactor removed). Precedent: shared-cron, compaction-auth,
   multi-agent watchdog were each "fixed for one → applied to all." (Infra/`.md` edits still need
   David's approval before writing.)
4. For **cross-cutting / infra / failure** questions, read `docs/RUNBOOK.md`.
5. **Never guess a messaging target** — each agent sends only to its own configured group (see
   user-memory). Sends, sheet writes, and any outward action are scoped per-agent.

## Adding a new agent (quickstart — distilled from building זורו, 2026-06-26)

Clone the closest peer (זורו/פיצי are the cleanest templates) and rename. Steps:

1. **Workspace.** Copy a peer to `workspace-<domain>/`; rewrite the 6 injected persona files
   (`AGENTS/SOUL/IDENTITY/USER/TOOLS/HEARTBEAT.md`) + `skills/<skill>/` (`SKILL.md`, `prompt-*.md`,
   grounded `knowledge.md`). Keep every always-on rule in `AGENTS.md` (only the 6 are injected).
2. **Smart infra is now SHARED — register, don't re-copy.** The hooks (ack-react, chat-log,
   group-reply-policy), session-hygiene and self-edit all live in `shared/` and are parameterized by
   `shared/registry.json` (**registry v2** — see Shared infrastructure above). To onboard a bot:
   **add the group(s) to the top-level `groups` map** (symbolic name → `{jid, label, requireMention,…}`)
   **and one agent entry** (`agentId`, `workspaceDir`, `identity {name,emoji}`, symbolic
   `primaryGroup`/`groups`, `cronTargets`, `configPath`, optional `roster`/`sessionHygiene`/`chatLog`) —
   that alone wires the hooks for the new group. ⚠️ **`workspace-*/.config/bot.json` (and job-scout.json)
   no longer carry any WhatsApp/session-hygiene wiring** — those fields were deleted; bot.json holds
   **domain config only** and the registry is the single source of truth. For session-hygiene/self-edit,
   drop a **thin shim** at
   `workspace-<x>/tools/{session-hygiene,self-edit}.mjs` that re-exports the shared lib and calls the
   shared CLI with the new agentId (copy zorro/poker's shim). Only the **domain** tool (`tools/<core>.mjs`
   + `lib/` pure logic) is genuinely new. `cd shared && node --test` green + `node tools/self-edit.mjs
   verify` (via the shim) → ok before wiring. No `KEY_PREFIX`/store-path/hook-dir renaming — the registry
   derives `agent:<id>:` and `agents/<id>/sessions` for you.
3. **Get the `group_id` (see also `docs/RUNBOOK.md` "Finding a new group's group_id").** Add the
   **bot's own number** (`openclaw directory self`) to the group first. ⚠️ For a NON-allowlisted group
   **nothing reaches journalctl or the gateway log** (verified 2026-07-14) — journalctl is sparse anyway;
   message-level logs live in **`/tmp/openclaw/openclaw-<date>.log`** (`web-inbound` lines, JID in `from`).
   Two working methods: (a) preferred, no config change — user sends a message in the group and you watch
   which `~/.openclaw/credentials/whatsapp/default/sender-key-*@g.us` file is created/updated at that
   moment (decrypt happens pre-allowlist; filter by mtime, there are many groups); (b) last resort, used
   2026-07-14 — temporarily set `groupPolicy:"open"` (both levels) → restart → user sends a message →
   read the JID from `/tmp/openclaw/openclaw-<date>.log` → **revert to `allowlist` immediately** + restart.
   **Verify the id with the user before wiring it — never guess a target.**
4. **Sync openclaw.json from the registry — do NOT hand-edit it.** Once the group + agent entries are
   in `shared/registry.json` (step 2), run `node shared/tools/registry-sync.mjs --check` (see the drift),
   then `--apply` — it writes the `agents.list[]` entry (**explicit Hebrew `mentionPatterns` from
   `identity` — ASCII auto-regex never matches Hebrew, which once silenced דיגיט**), the
   `channels.whatsapp.accounts.default.groups` allowlist entry, and **prepends** the `bindings[]` route
   (peer beats main's catch-all) — atomically, with a timestamped backup of openclaw.json + registry.json
   to `shared/backups/registry-sync/`, and also sets each cron's `delivery.to`. **No `hooks.*` edit** —
   `extraDirs` already points at `shared/hooks` and the new bot is picked up the moment it's in the
   registry. Then a clean gateway restart while idle (`--apply` prints the reminder when openclaw.json
   changed). (Editing shared state + restart is a guarded action — expect a permission gate; confirm the
   target with David first.)
5. **Optional:** daily `openclaw cron add …` — **MUST follow the shared cron architecture** (see Shared infrastructure above + RUNBOOK "Shared cron architecture"): FIXED content → a `data/feeds/<name>.json` + `feedEchoMessage(cron-feed … print)`; DYNAMIC content → a state-owning tool + `withContract()`. Never compose-and-log in one cron turn (that's how דאוס's lesson shipped a status line instead of the lesson). Also per-agent `session-hygiene-<id>` systemd timer (every 5 min — **each live bot has one** since 2026-06-29, boot-staggered; ExecStart → `workspace-<x>/tools/session-hygiene.mjs` shim; פיצי's timer is expected disabled since it was archived 2026-07-17). Without it a bot's group session poisons silently when its `totalTokens` overruns the context window — proactively cleared by this timer + backstopped by the multi-agent `gateway-watchdog.sh` CHECK C. See RUNBOOK "compaction-poisoned session".

🔒 **Isolation guarantee to preserve:** `groupPolicy: "allowlist"` means the gateway processes messages
**only** from explicitly-listed groups — any other group the bot number is in (incl. private ones) is
silently ignored. Keep it `allowlist`; never leave it `open` (a temporary flip for JID discovery — step 3b —
must be reverted immediately). Each agent only ever acts in its wired group.
Each agent's `ACTIVATION.md` has the exact copy-paste snippets.

## Listen-only group mode (built 2026-07-14 for digit's ex-primary group)

A group the bot must **hear but never answer in** (not even when called by name), with its content
queryable from the bot's other groups. Pattern (live instance + ids: `workspace-realestate/CLAUDE.md`
"Multi-group" + `~/.openclaw/CLAUDE.md`):

1. Add the group to the registry's top-level `groups` map with `listenOnly:true`, `requireMention:false`,
   `routeAgentId:"listener"`, and a `systemPrompt` mandating an exact-`NO_REPLY` answer (OpenClaw's
   silent-reply token — nothing is delivered), then list its symbolic name in the OWNING agent's
   `listenGroups` (NOT its `groups`). `registry-sync --apply` binds the route to the shadow agent
   **`listener`** (`workspace-listener/`, haiku, unmatchable `mentionPatterns` → a mention of the real
   bot's name is NOT a mention for listener) and writes the allowlist entry. ⚠️ dispatch-per-message is
   REQUIRED: non-dispatched messages exist only in gateway memory and are lost on restart; dispatching
   persists them to `~/.openclaw/agents/listener/sessions/`.
2. `shared/tools/listen-export.mjs` (registry-generic — systemd `openclaw-listen-export.timer`, 15 min)
   appends new messages to the owning bot's `data/chat-log/<jid>.jsonl` → daily `reflect` distills into
   `group-notes.md` (bootstrap-injected); the owning bot's `AGENTS.md` also points it at the chat-log.
3. A listenOnly group stays **OUT** of any agent's `groups` (it lives only in the top-level `groups` map
   + the owner's `listenGroups`) — otherwise the 👍 ack-react hook and session-hygiene reset-notices would
   post into the "silent" group. bot.json no longer carries group ids at all.
