# Spec: "Working on it" indicator for Scotty (WhatsApp)

**Date:** 2026-05-26
**Status:** Approved
**Scope:** Small — skill-prompt change only, no new code.

## Problem

When David sends Scotty a WhatsApp message, replies sometimes take a while (model
startup + searches + sheet reads). David has no signal that the message was received
and is being worked on, so it's unclear whether the bot is alive or stuck.

## Goal

Give David a lightweight, immediate-ish signal that Scotty received his message and is
working, plus a signal that it finished.

## Decision

Use **WhatsApp emoji reactions** on David's incoming message:
- **👀** as Scotty's **first action** on any inbound conversational message — "got it, working".
- **✅** replacing it once the reply has been sent — "done".

On WhatsApp each sender may have only one reaction per message, so reacting ✅ replaces
the 👀 automatically (no need to remove first).

Rejected alternatives:
- *Text ack ("רגע, בודק…")* — clutters the chat with an extra message every time.
- *Native typing indicator* — not exposed by the OpenClaw CLI.

## Behavior

```
inbound WhatsApp message from David (Q&A mode)
  │
  ├─ FIRST tool action:  react 👀 on that message-id
  ├─ do the work (read sheet / search / classify / etc.)
  ├─ send the reply
  └─ LAST action:        react ✅ on that message-id   (replaces 👀)
```

### Applies to
- Conversational (Q&A) inbound messages from David in the configured group **only**.

### Does NOT apply to
- The 09:00 cron `scout` run (no inbound message to react to).
- The "0 new jobs / 0 changes → send nothing" case still sends nothing, but the
  reaction lifecycle still completes: 👀 on receipt → ✅ when done (so David sees it
  was processed even when there's no reply). For an explicit no-op acknowledgement,
  ✅ alone is the signal.

## Implementation

Two edits, both in `workspace/skills/job-scout/`:
1. **`prompt-qa.md`** — add a mandatory step block: react 👀 first, react ✅ after replying.
2. **`SKILL.md`** — add one line under conversational mode + the command needed.

Command (target = `group_id` from `workspace/.config/job-scout.json`):
```
/home/davidtobol2580/open_claw/openclaw message react \
  --channel whatsapp --target "<group_id>" --message-id "<inbound_msg_id>" --emoji "👀"
```
Replace `👀` with `✅` for the completion reaction.

The agent must capture the inbound message's id when the message arrives (provided by
the channel runtime) to target the reaction.

## Out of scope (future)

Gateway-level hook that fires 👀 the instant the message lands (before the model wakes),
for truly instantaneous feedback. Deferred — current skill-level approach covers the
bulk of the wait and needs no new infrastructure.

## Success criteria

- David sends a message → within seconds a 👀 reaction appears on it.
- When Scotty's reply lands, the reaction becomes ✅.
- Cron scout runs are unaffected.
