# דילר — Poker Home-Game Assistant (read this first)

> This file is a dev map for humans. It is NOT auto-loaded into דילר's system prompt.
> Last reviewed: 2026-06-13.

> ⚠️ **Dev note — what the conversational agent actually loads.** OpenClaw's `claude-cli` agent
> injects ONLY these workspace files into the system prompt: **AGENTS.md, SOUL.md, IDENTITY.md,
> USER.md, TOOLS.md, HEARTBEAT.md**. It does **NOT** auto-load this `CLAUDE.md` or the skill's
> `SKILL.md` (those are read on-demand only). So **any rule that must ALWAYS apply belongs in
> `AGENTS.md` (or IDENTITY/SOUL)** — that's where the persona, the golden "numbers-from-the-tool"
> rule, the "always reply / never NO_REPLY" rule, the greeting, and the knowledge-file pointers live.

## What this is

**דילר (Dealer) 🎰** is the bot of a **friendly home poker group**. It lives in **one WhatsApp group**,
responds **only when addressed as "דילר"** (`requireMention: true`), and serves everyone in the group.
It does four things, all in Hebrew:

1. **Bank & accounts** — tracks each player's buy-ins / cash-outs per game night, computes net
   results, and the end-of-night **settle-up** (who pays whom, minimal transfers).
2. **Game organizing** — opens a game night, collects RSVP (in/out/maybe), stores location + time.
3. **Stats & leaderboard** — lifetime net ranking, sessions played, biggest win/loss, win/loss count.
4. **Poker coaching** — odds, pot odds, ranges, position, hand analysis (grounded in `strategy.md`).

> **Relationship to Scotty & דיגיט:** דילר is a **completely separate agent**. It shares ONLY the
> OpenClaw runtime (gateway + WhatsApp account) with Scotty (`../workspace/`) and דיגיט
> (`../workspace-realestate/`). Separate workspace, skill, data, persona, and **per-group routing**
> mean none can affect another's behavior or data. Do NOT touch the sibling workspaces.

## Architecture (mirrors דיגיט)

- **Same OpenClaw runtime, separate isolated agent.** Registered in `~/.openclaw/openclaw.json`
  `agents.list` (id `poker`, name דילר 🎰, mentionPatterns `["דילר"]`, this dir as `workspace`).
- **Routing** — a peer-level `bindings` entry pins this group's messages to `poker`; OpenClaw's route
  engine checks `match.peer` first, so Scotty's catch-all `{channel:"whatsapp"}` binding stays the
  fallback for every other group.
- **Group must be in the WhatsApp allowlist** (`channels.whatsapp.accounts.default.groups`) with
  `requireMention: true`.
- **Hooks** (`tools/hooks/`, registered via `hooks.internal.load.extraDirs`):
  - `ack-react-poker` — deterministic 👍 on every inbound group message (below the LLM).
  - `chat-log-poker` — mirrors chat → `data/chat-log/<group>.jsonl` + regenerates `RECENT_CHAT.md`,
    and writes `data/last-inbound.json` (sender e164/fromMe) so דילר can attribute messages.
- **Session hygiene** (`tools/session-hygiene.mjs` + systemd timer `openclaw-session-hygiene-poker.timer`,
  every 5 min): keeps the group's conversational session SMALL so OpenClaw's (broken) preflight
  compactor never has to run. Restart-free — archives the transcript + prunes the store entry via
  `openclaw sessions cleanup`; a fresh small session is auto-created on the next inbound; continuity
  survives via `RECENT_CHAT.md`. Resets on: size cap (`max_transcript_bytes`, 600KB), idle-gated
  daily reset (06:00 Asia/Jerusalem), and a SILENT proactive heal of any assistant-only ("poisoned")
  session. Config in `.config/bot.json` → `session_hygiene`. Pure decision fns unit-tested
  (`session-hygiene.test.mjs`). **Monitoring at gateway level** (dead-harness → restart) is handled by
  the EXISTING global `openclaw-watchdog.timer` (Scotty's), which restarts the whole gateway and thus
  revives all agents incl. poker — so no second 60s watchdog was added for poker (avoids restart thrash;
  poker has no cron, the main poison source). Add a poker-scoped CHECK-B/C watchdog later if faster
  reactive recovery is wanted.

## Layout

```
workspace-poker/
├── IDENTITY.md SOUL.md AGENTS.md USER.md TOOLS.md HEARTBEAT.md   # persona (auto-loaded)
├── RECENT_CHAT.md            # continuity (chat-log hook regenerates)
├── CLAUDE.md                 # this dev map (NOT auto-loaded)
├── .config/bot.json          # whatsapp.group_id/group_name + session_hygiene
├── skills/poker-buddy/
│   ├── SKILL.md              # entry point: 4 modes + tool table + hard rules
│   ├── prompt-qa.md          # the conversational turn (sender resolve → route → tool → Hebrew reply)
│   ├── router.md             # Hebrew intent table (commands + NL regexes → poker.mjs)
│   └── strategy.md           # poker coaching knowledge (read on demand)
├── tools/
│   ├── poker.mjs             # THE deterministic ledger CLI (JSON out)
│   ├── lib/poker.mjs         # pure functions (resolve/results/settle/stats) — unit-tested
│   ├── lib/poker.test.mjs    # `node --test tools/lib/*.test.mjs`
│   └── hooks/{ack-react-poker,chat-log-poker}/
└── data/
    ├── players.json          # player registry  { players:[{id,name,e164,aliases}] }
    ├── sessions.json         # all game nights   { sessions:[<session>] }
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
cd /home/davidtobol2580/open_claw/workspace-poker
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
1. WhatsApp sends go **only** to the configured group (`.config/bot.json` → `whatsapp.group_id`).
2. **Never invent a number.** Every amount/balance/result comes from `poker.mjs`.
3. **Never delete** players or past sessions without explicit confirmation — `reopen`/correct instead.
4. **Hebrew** to the group; English for tool calls.
5. Don't promote real-money gambling / chasing losses — it's a friendly home game.
6. Always reply when addressed (group is `requireMention`); never `NO_REPLY`, never go silent.

## Status / open items
- ✅ **WIRED & LIVE (2026-06-13).** Group **"ערב פוקר"** = `120363000000000000@g.us` (verified via
  David's own outbound: his LID `<OWNER_LID>` on the freshest sender-key matched his "בדיקה" send).
  Registered: `agents.list[poker]` (model sonnet-4-6, identity 🎰 דילר, `groupChat.mentionPatterns:["דילר"]`),
  peer `bindings` route before main's catch-all, group allowlisted `requireMention:true`, hooks extraDir
  added (`ack-react-poker` + `chat-log-poker` both `✓ ready`), `.config/bot.json` group_id set. Gateway restarted.
- **Member recognition is interaction-based, not roster-based.** The WhatsApp adapter does NOT expose
  group-member listing (`directory groups members` → "Channel whatsapp does not support…"). So דילר knows
  a person once they *speak* (chat-log resolves their e164 → name from `players.json`) or once registered
  via `add-player` (happens naturally on the first buy-in). Pre-register regulars to seed the roster.
- **No history backfill.** `RECENT_CHAT.md` builds forward from the first message after wiring; messages
  sent before (incl. the initial "בדיקה") are not logged. Context accumulates from now on.
- Model: conversational sessions use `anthropic/claude-sonnet-4-6`. Bump to opus in `agents.list[poker].model`
  if coaching quality needs it.
