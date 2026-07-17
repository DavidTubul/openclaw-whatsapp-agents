# דאוס — Poker Home-Game Assistant (read this first)

> This file is a dev map for humans. It is NOT auto-loaded into דאוס's system prompt.
> Last reviewed: 2026-07-13.

> ⚠️ **Dev note — what the conversational agent actually loads.** OpenClaw's `claude-cli` agent
> injects ONLY these workspace files into the system prompt: **AGENTS.md, SOUL.md, IDENTITY.md,
> USER.md, TOOLS.md, HEARTBEAT.md**. It does **NOT** auto-load this `CLAUDE.md` or the skill's
> `SKILL.md` (those are read on-demand only). So **any rule that must ALWAYS apply belongs in
> `AGENTS.md` (or IDENTITY/SOUL)** — that's where the persona, the golden "numbers-from-the-tool"
> rule, the "always reply / never NO_REPLY" rule, the greeting, and the knowledge-file pointers live.

## What this is

**דאוס 🎰** (formerly **דילר** / Dealer — the old name; the persona + wake-word were renamed) is the bot
of a **friendly home poker group**. It lives in **one WhatsApp group**, responds **only when addressed as
"דאוס"** (`requireMention: true`, mentionPatterns `["דאוס"]`), and serves everyone in the group.
It does four things, all in Hebrew:

1. **Bank & accounts** — tracks each player's buy-ins / cash-outs per game night, computes net
   results, and the end-of-night **settle-up** (who pays whom, minimal transfers).
2. **Game organizing** — opens a game night, collects RSVP (in/out/maybe), stores location + time.
3. **Stats & leaderboard** — lifetime net ranking, sessions played, biggest win/loss, win/loss count.
4. **Poker coaching** — odds, pot odds, ranges, position, hand analysis (grounded in `strategy.md`).

> **Relationship to the other agents:** דאוס is a **completely separate agent**; the repo hosts five
> bots that share only the OpenClaw runtime — see `../CLAUDE.md`. Do NOT touch the sibling workspaces.

## Architecture (mirrors דיגיט)

- **Same OpenClaw runtime, separate isolated agent.** Registered in `~/.openclaw/openclaw.json`
  `agents.list` (id `poker`, name דאוס 🎰, mentionPatterns `["דאוס"]`, this dir as `workspace`).
- **Routing** — a peer-level `bindings` entry pins this group's messages to `poker`; OpenClaw's route
  engine checks `match.peer` first, so Scotty's catch-all `{channel:"whatsapp"}` binding stays the
  fallback for every other group.
- **Group must be in the WhatsApp allowlist** (`channels.whatsapp.accounts.default.groups`) with
  `requireMention: true`.
- **Hooks** (SHARED — `shared/hooks/`, the single set for all 5 bots, registered via
  `hooks.internal.load.extraDirs`; they resolve poker by its group jid via `shared/registry.json`):
  - `ack-react` — deterministic 👍 on every inbound group message (below the LLM).
  - `chat-log` — mirrors chat → `data/chat-log/<group>.jsonl` + regenerates `RECENT_CHAT.md`,
    and writes `data/last-inbound.json` (sender e164/fromMe) so דאוס can attribute messages.
  - `group-reply-policy` — injects the shared group-reply policy into `AGENTS.md` at bootstrap
    (single source `shared/lib/reply-policy.mjs`).
  - `group-memory` — injects the bot's learned `data/memory/group-notes.md` at bootstrap; rewritten
    daily by `shared/tools/reflect.mjs` (via the openclaw-reflect timer).
- **Session hygiene** (`tools/session-hygiene.mjs` — a thin shim over `shared/lib/session-hygiene.mjs`
  with agentId `poker`; params from `shared/registry.json` — + systemd timer `openclaw-session-hygiene-poker.timer`,
  every 5 min): keeps the group's conversational session SMALL so OpenClaw's (broken) preflight
  compactor never has to run. Restart-free — archives the transcript + prunes the store entry via
  `openclaw sessions cleanup`; a fresh small session is auto-created on the next inbound; continuity
  survives via `RECENT_CHAT.md`. Resets on: size cap (`max_transcript_bytes`, 600KB), idle-gated
  daily reset (06:00 Asia/Jerusalem), and a SILENT proactive heal of any assistant-only ("poisoned")
  session. Config in `shared/registry.json` → the poker agent's `sessionHygiene` block (moved out of
  bot.json in the registry-v2 refactor). Pure decision fns unit-tested in the
  shared lib (`cd shared && node --test lib/session-hygiene.test.mjs`; the per-bot file is a thin shim).
  **Monitoring at gateway level** (dead-harness → restart) is handled by
  the EXISTING global `openclaw-watchdog.timer` (Scotty's), which restarts the whole gateway and thus
  revives all agents incl. poker — so no second 60s watchdog was added for poker (avoids restart thrash).
  Add a poker-scoped CHECK-B/C watchdog later if faster reactive recovery is wanted.
- **Crons (Dor coaching, added since; follow the SHARED cron architecture — see repo CLAUDE.md + RUNBOOK):**
  three daily jobs to the group, all DYNAMIC (a tool owns state + the agent writes + the shared
  announce-contract, so `announce` can't leak a status line):
  - `dor-poker-morning-lesson` (08:02 wkdays) — `tools/dor-lesson.mjs next` walks `data/dor-syllabus.json`
    (37 topics → then endless distinct "advanced scenario" lessons), counts the lesson # **up forever** and
    **never repeats** (passes a `covered` list, seeded in `data/dor-lesson-state.json` with the ~20 hands
    already taught). Extend by editing `data/dor-syllabus.json` (pure data).
  - `dor-poker-evening-quiz` (20:00 wkdays) — `tools/dor-quiz.mjs` reads `last_topic` from the lesson state;
    the quiz tests **that morning's** lesson (no answer revealed).
  - `dor-teder-daily` (08:08 daily) — `tools/dor-teder.mjs next` rotates all 9 members **forever** (wraps);
    the cynical roast, grounded in `data/roster.md`. State: `data/dor-teder-state.json`.
  (The shared FIXED-content `cron-feed` path exists too, but Dor's content is dynamic.) ⚠️ When editing a
  cron schedule, pass `--tz Asia/Jerusalem` (a bare `--cron` resets to the host's UTC).

## Layout

```
workspace-poker/
├── IDENTITY.md SOUL.md AGENTS.md USER.md TOOLS.md HEARTBEAT.md   # persona (auto-loaded)
├── RECENT_CHAT.md            # continuity (chat-log hook regenerates)
├── CLAUDE.md                 # this dev map (NOT auto-loaded)
├── .config/bot.json          # domain config only (dorTag) — WhatsApp wiring + session-hygiene now live in shared/registry.json
├── skills/poker-buddy/
│   ├── SKILL.md              # entry point: 4 modes + tool table + hard rules
│   ├── prompt-qa.md          # the conversational turn (sender resolve → route → tool → Hebrew reply)
│   ├── router.md             # Hebrew intent table (commands + NL regexes → poker.mjs)
│   ├── strategy.md           # poker coaching knowledge (read on demand)
│   └── leaderboard-format.md # the leaderboard's fixed display format (read on demand)
├── tools/
│   ├── poker.mjs             # THE deterministic ledger CLI (JSON out)
│   ├── dor-lesson.mjs        # daily Dor lesson cron tool (owns syllabus position; `next`)
│   ├── dor-quiz.mjs          # evening quiz on that morning's lesson (reads lesson state)
│   ├── dor-teder.mjs         # daily member-rotation roast tool (owns rotation; `next`)
│   ├── lib/poker.mjs         # pure functions (resolve/results/settle/stats) — unit-tested
│   ├── lib/poker.test.mjs    # `node --test tools/lib/*.test.mjs`
│   ├── lib/dor-lesson-dyn.mjs      # pure lesson/syllabus logic (+ dor-lesson-dyn.test.mjs)
│   ├── lib/dor-teder.mjs           # pure rotation logic       (+ dor-teder.test.mjs)
│   ├── self-edit.mjs         # thin shim → shared/bin/self-edit.mjs (agentId poker)
│   └── session-hygiene.mjs   # thin shim → shared/lib/session-hygiene.mjs (agentId poker)
│                             # gateway hooks are SHARED — see shared/hooks/ (not per-workspace)
└── data/
    ├── players.json          # player registry  { players:[{id,name,e164,aliases}] }
    ├── sessions.json         # all game nights   { sessions:[<session>] }
    ├── roster.md             # group-member roster (grounds the daily roast)
    ├── dor-syllabus.json     # the lesson syllabus (pure data — extend here)
    ├── dor-lesson-state.json # lesson counter + covered topics (owned by dor-lesson.mjs)
    ├── dor-teder-state.json  # roast rotation position (owned by dor-teder.mjs)
    ├── chat-log/<group>.jsonl
    └── last-inbound.json
```

## Data model (`data/sessions.json`)

A session: `{ id, date, location, time, status: planned|active|closed, rsvp:{in,out,maybe},
entries:{ <playerId>:{ buyins:[..], cashout:number|null } }, created, updated }`.
- net per player = `cashout − sum(buyins)`.
- **settle-up** = greedy min-transfer matching of nets (`settleUp()` in `lib/poker.mjs`).
- **leaderboard / lifetime stats** aggregate **closed sessions only** (open games are in-progress).
- `close` refuses to close an **unbalanced** session (cash-outs ≠ buy-ins, or someone hasn't cashed
  out) unless `--force`.

## How to operate (shell)
```bash
cd ~/open_claw/workspace-poker
node tools/poker.mjs players | add-player "<name>" [e164] | find-player "<q>"
node tools/poker.mjs session new [--location ".."] [--time "21:00"] [--date YYYY-MM-DD]
node tools/poker.mjs session list | current | show [id] | start [id]
node tools/poker.mjs rsvp "<player>" <in|out|maybe>
node tools/poker.mjs buyin "<player>" <amount>   |  cashout "<player>" <amount>
node tools/poker.mjs results [id] | close [id] [--force] | reopen [id] | settle [id]
node tools/poker.mjs leaderboard | balance ["<player>"]
node --test tools/lib/*.test.mjs                 # unit suite (10 tests)
POKER_DATA_DIR=/tmp/x node tools/poker.mjs ...    # isolate data dir (tests/smoke)
```

## Hard rules (NEVER violate)
1. WhatsApp sends go **only** to the configured group (the poker agent's group in `shared/registry.json`).
2. **Never invent a number.** Every amount/balance/result comes from `poker.mjs`.
3. **Never delete** players or past sessions without explicit confirmation — `reopen`/correct instead.
4. **Hebrew** to the group; English for tool calls.
5. Don't promote real-money gambling / chasing losses — it's a friendly home game.
6. Always reply when addressed (group is `requireMention`); never `NO_REPLY`, never go silent.

## Status / open items
- ✅ **WIRED & LIVE (2026-06-13).** Group **"ערב פוקר"** = `120363000000000000@g.us` (verified via
  David's own outbound: his LID `<OWNER_LID>` on the freshest sender-key matched his "בדיקה" send).
  Registered: `agents.list[poker]` (model sonnet-5, identity 🎰; wired 2026-06-13 as דילר with
  `mentionPatterns:["דילר"]`, since renamed — identity + wake-word are now **דאוס**, `mentionPatterns:["דאוס"]`),
  peer `bindings` route before main's catch-all, group allowlisted `requireMention:true`. (All of this is
  now DERIVED from `shared/registry.json` via `registry-sync --apply`, not hand-set in openclaw.json/bot.json.)
  Gateway restarted. (Hooks are now the SHARED `ack-react`/`chat-log`/`group-reply-policy`
  packs under `shared/hooks/`, resolving poker by group via the registry — they replaced the old
  per-workspace `ack-react-poker`/`chat-log-poker` copies in the 2026-06-26 shared-infra refactor.)
- **Member recognition is interaction-based, not roster-based.** The WhatsApp adapter does NOT expose
  group-member listing (`directory groups members` → "Channel whatsapp does not support…"). So דאוס knows
  a person once they *speak* (chat-log resolves their e164 → name from `players.json`) or once registered
  via `add-player` (happens naturally on the first buy-in). Pre-register regulars to seed the roster.
- **No history backfill.** `RECENT_CHAT.md` builds forward from the first message after wiring; messages
  sent before (incl. the initial "בדיקה") are not logged. Context accumulates from now on.
- Model: conversational sessions use `anthropic/claude-sonnet-5`. Change it in `agents.list[poker].model`
  if coaching quality needs it.
