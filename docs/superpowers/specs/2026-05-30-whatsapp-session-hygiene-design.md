# WhatsApp Session Hygiene — Design

> Status: **proposed** · Date: 2026-05-30 · Owner: dev session (Scotty / OpenClaw)
> Goal: the conversational WhatsApp session must never (a) bloat until the bot hallucinates,
> nor (b) get stuck/silent on a broken compaction. Resets happen by **real size**, not by clock.

## Problem (corrected diagnosis)

The bot occasionally goes silent on inbound WhatsApp messages. Earlier notes attributed this to
"the session filled `contextTokens` to the 1M cap." **That field was misread.**

Verified facts (2026-05-30):
- `sessions.json.contextTokens` is **constant = 1,048,576** for *every* session, including a
  brand-new 6-line / 12K session. It is the configured **context-window size**, not live fullness.
- `sessions.json.totalTokens` is **cumulative** (input+output+cacheRead summed over the session's
  whole life — e.g. 651K on a 12K file). Also not a fullness gauge.
- The real failure on 2026-05-28 was: preflight compaction fired, then failed with
  `no real conversation messages` + `sessionId=unknown` — the compactor **could not find the
  session `.jsonl`** (it was missing from disk while `sessions.json` still referenced it). This is
  a file/integrity failure, and it is exactly the state a **non-atomic reset** (delete file, keep
  entry) produces.
- The daily cron scout runs with `Target: isolated` (its own session), so its large tool outputs
  do **not** accumulate in the conversational group session. Growth of the group session comes from
  David's chat **plus tool outputs the bot generates while answering** (e.g. `sheet.mjs read` /
  `gmail-search` dumping large JSON into the conversation).

### Core insight
OpenClaw's broken compactor only runs when a session is **large** (preflight fires at ~0.8 ×
context window). **If the session is never allowed to get large, compaction never runs, so it can
never fail.** That single property delivers everything the user asked for at once: always fresh
(no hallucination), no waste (caching works between resets), never stuck (compaction never fires),
and resets scale with real usage (busy day → more resets, quiet day → none) rather than the clock.

## Goals
1. The conversational group session never grows large enough to trigger OpenClaw compaction.
2. Resets are driven by a **real, local measure of session size**, not by time.
3. A reset never loses David's practical context — short external chat-log gives continuity.
4. The bot **never goes silent**: any failure degrades to a reply, not silence.
5. Reduce per-turn growth so resets stay rare and each turn stays cheap.

## Non-goals
- Touching the daily cron scout pipeline (already isolated; out of scope).
- Making OpenClaw's native compaction work (we avoid it instead of fixing vendor internals).
- Any change to Gmail/Sheet/messaging behavior or the hard rules in `CLAUDE.md`.

## Architecture — four layers

### Layer 1 — Reset triggers: size (primary) + age (secondary, idle-gated)
Two triggers; a reset fires when **either** is true (and the session is idle — see Layer 2):

**Primary — real fullness via active-session `.jsonl` byte size.** The size proxy is **bytes of the
active session's `.jsonl`**, not `contextTokens`, not line count. Bytes capture both message count
*and* large tool outputs (the real drivers; lines are ~0.6–2.3KB each and a single sheet dump dwarfs
a chat line). ~4 bytes ≈ 1 token. This trigger is the one that *prevents the bug* (a large session
is what makes the broken compactor run and makes the bot hallucinate).
- Window ≈ 1,048,576 tokens; OpenClaw preflight fires near 0.8× ≈ 838K tokens ≈ ~3.3MB of `.jsonl`.
- **Reset threshold (default): 1,000,000 bytes (~1MB ≈ ~250K tokens ≈ ~0.24× window).** Comfortably
  below the compaction trigger, low enough to keep the session fresh. **Tunable.**
- The hygiene check **logs the current byte size on every run** so we can calibrate the threshold
  against real growth over the first week and adjust.

**Secondary — daily morning-quiet reset (freshness floor).** Once per day, reset in the early-morning
**quiet window** — **shortly before the daily scout** (scout cron is currently `0 8 * * *`
Asia/Jerusalem, so default reset ≈ **07:30 Asia/Jerusalem**) — **idle-gated** so it never cuts off a
live chat. Anchoring to the morning window (rather than a generic 24h age) is deliberate: that is
when David is reliably not chatting, so the reset is invisible, and he wakes to a fresh, clean
session for the day's interactions. Note the daily scout runs in its **own isolated session** and
its `announce` push does **not** enter the conversational session, so resetting just before it is
safe and loses nothing. On a busy day the size trigger usually fires first anyway; this daily reset
is the freshness floor for low-volume days, not the bug-prevention mechanism. Guard against
double-firing: skip if a reset already happened in the last few hours.

Resolving "the active session file" for the group: read `sessions.json`, find key
`agent:main:whatsapp:group:120363000000000000@g.us`, take its `sessionFile`.

### Layer 2 — Reset via the supported, restart-free primitive
**Verified by spike (2026-05-30):** archiving a session's transcript and then running
`openclaw sessions cleanup --fix-missing --enforce` drops the orphaned store entry, and the
**next turn on that session key is served by a brand-new session — with no gateway restart.**
(Spike: key `diagnostic:hygiene-spike`, old `be60351a…` → new `e3c3cbed…`, gateway never restarted.)
This is the reset primitive. **No `sessions.json` hand-editing under the live process, and no
gateway restart** — restarts are a known trigger of the harness-deregistration failure and are
explicitly avoided.

The continuity chat-log (Layer 3) is maintained continuously by the hook, so at reset time the
record + `RECENT_CHAT.md` are already current — reset does not touch them.

Reset steps, in order:
1. Confirm the session is **idle** (see below). If not, skip this tick and retry next tick.
2. Back up `sessions.json` → `sessions.json.bak-<ts>` (timestamp from the shell, not in-process).
3. Archive the group's transcript: `mv <id>.jsonl <id>.jsonl.archived-<ts>` (never `rm`).
4. Run `openclaw sessions cleanup --fix-missing --enforce` to prune the now-orphaned entry.
5. Send the reset notification to the group (Layer 4 / hard rule #1: configured `group_id` only).

If step 3 or 4 fails, abort: a session whose transcript still exists is simply left intact (a
working—if large—session is strictly better than a broken one). Because the entry is pruned *by
openclaw's own command after* the file is archived, the missing-file-but-entry-kept state (the
2026-05-28 root cause) cannot persist.

Note: `--fix-missing --enforce` prunes **all** entries with missing transcripts (the spike pruned 45
stale orphan entries, 56→11). This is harmless—beneficial cleanup of dead rows; the only *live*
session with a missing transcript at that moment is the one we just archived.

**Idle gate:** the session is idle iff its transcript `.jsonl` has not been modified in the last
`IDLE_SECS` (default 90s) — a turn writes to the transcript, so a recent mtime means a turn is
active or just finished. Local, no journal dependency. This guarantees a reset never yanks the file
mid-reply.

### Layer 3 — Continuity chat-log (survives resets)
Two artifacts, clean separation between **full-fidelity record** and **lean injected view**:

- **Full record** — `workspace/data/chat-log/120363000000000000@g.us.jsonl`, **append-only, never
  trimmed**. One record per message: `{ ts, from: "david"|"scotty", text }` storing the **full
  text** of David's messages and Scotty's replies. This is the complete, faithful archive — nothing
  is lost, and it doubles as a human-readable debug/audit log ("what did David ask yesterday?").
- **Injected view** — `workspace/RECENT_CHAT.md`, regenerated from the tail of the full record:
  the **last N = 30 exchanges**, with long Scotty replies truncated/condensed to keep the per-turn
  injection lean. Referenced from the prompt and read each turn, so a fresh post-reset session still
  knows what was just discussed without paying full-history cost every turn.
- Written by a small gateway hook on `message:received` and `message:sent` (same mechanism family
  as the existing `ack-react` hook), so it is independent of the LLM and survives session resets.

This is what answers "is past content preserved correctly?": the **full text lives in the
append-only record** (never trimmed, plus the archived `.jsonl` files), recent context **flows into
the new session** via `RECENT_CHAT.md`, and all real tracking data (jobs/statuses) is in the Google
Sheet, untouched by any reset.

### Layer 4 — Graceful degradation (never silent)
Belt-and-suspenders so a failure is never silence:
- If a preflight-compaction / harness error is detected for an inbound turn, the bot still emits a
  reply path — at minimum a short "רגע, מאפס זיכרון ומיד חוזר 🙂" — instead of dropping the turn.
- The existing `gateway-watchdog.sh` stays as the last line of defense (it already greps the journal
  for the error, resets, and nudges David to resend). With Layers 1–2 in place it should rarely
  trigger, but it remains the safety net.

## Reduce growth (orthogonal, makes resets rare) — **separate phase**
- Trim the per-turn **skills snapshot**: Scotty uses ~1–2 of ~23 skills; scope the conversational
  session to just those → saves ~2.7K tokens/turn.
- **Summarize large tool outputs** in the conversational session (e.g. cap/condense `sheet.mjs read`
  and `gmail-search` JSON after the bot has used them) so a single status query doesn't dump tens of
  KB into the session history.
- Review which `workspace/*.md` files truly need injection every turn.

This phase is **deferred** to keep the core mechanism (Layers 1–4) shippable and low-risk first.

## Data flow
```
inbound WhatsApp msg ──► ack-react 👍 (existing, LLM-independent)
                     └─► chat-log hook appends {david,text}        (Layer 3)
                     └─► agent turn ── reads RECENT_CHAT.md ──► reply
                                          └─► chat-log hook appends {scotty,summary}
hygiene check (periodic, e.g. existing watchdog timer / cron tick):
   read sessions.json ► group sessionFile bytes ► log size
        ├─ bytes < threshold AND not in morning-quiet window ► do nothing
        └─ (bytes ≥ threshold) OR (≈07:30 daily window AND no reset in last few hours):
               └─ session idle? ── yes ► atomic reset (Layer 2)  [continuity already in chat-log]
                                └─ no  ► skip this tick, retry next tick (never interrupt a live chat)
```

## Error handling
- Reset aborts safely (entry kept) on any IO error → never produces the broken state.
- Missing `sessionFile` / missing entry → treated as already-clean, no-op.
- chat-log write failure is non-fatal (logged; bot still replies).
- All hygiene actions cooldown-gated and skip-if-mid-turn, mirroring existing watchdog conventions.

## Testing
- **Metric**: unit-test the size reader against a fixture `sessions.json` + fixture `.jsonl`
  (correct file resolved, bytes computed, threshold comparison).
- **Atomic reset**: test ordering — inject a failure at the archive step and assert the entry was
  NOT removed (no broken state); success path asserts entry removed *before* file archived.
- **chat-log**: append + rolling-window-of-30 read; `RECENT_CHAT.md` renders the tail.
- **Idle gate**: reset is skipped when a turn is in flight.
- **End-to-end (manual)**: drive the group session past threshold with synthetic content, confirm
  reset fires, fresh session starts, `RECENT_CHAT.md` carries the last exchanges, bot replies
  normally, and zero `Preflight compaction required but failed` lines appear.

## Open decisions (defaults chosen; confirm at review)
- **Reset threshold (size)**: default 1,000,000 bytes — confirm or tune after a week of size logging.
- **Daily reset**: default = ON, ≈07:30 Asia/Jerusalem (just before the 08:00 scout), idle-gated,
  de-duped against a recent size-triggered reset. Anchored to the morning quiet window per David's
  request so it never interrupts a chat.
- **Reset notification**: default = brief one-line message to the group on every reset (so David
  isn't confused why context "reset"); alternative = fully silent.
- **chat-log window N**: default 30 exchanges in the injected view; full record never trimmed.
- **Trim phase**: default = deferred to a separate plan after the core mechanism ships.

## Rollout / ops notes
- Hooks live under `workspace/` (survive `openclaw` upgrades), like `ack-react`.
- Do **not** restart the gateway to apply skill/prompt edits (hot-reload; restart drops the
  in-flight turn). Reset acts on `sessions.json` + files, not via restart.
- Any vendored `dist/` patch (if Layer 4 needs one) is non-stock and must be re-applied after an
  `npm i -g openclaw` upgrade — document it in `CLAUDE.md` if used.
