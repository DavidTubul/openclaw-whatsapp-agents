# Spec: Deterministic 👍 acknowledgment for Scotty (WhatsApp)

**Date:** 2026-05-27
**Status:** Approved (design)
**Scope:** Small — one new gateway hook handler + config registration + prompt cleanup.
**Supersedes:** `2026-05-26-working-indicator-design.md` (the LLM-driven 👀→✅ indicator).

## Problem

Scotty's acknowledgment of incoming WhatsApp messages is **unreliable**. The current
design (`2026-05-26-working-indicator-design.md`) instructs the LLM to react 👀 first and
✅ last on every inbound conversational message. In practice the conversational model
(Sonnet 4.6) **skips these reactions under load** — gateway logs from 2026-05-27
00:19–00:23 show Scotty sending replies to every message with *zero* reactions. David
therefore has no consistent signal that a message was received.

A second, related complaint: David asked Scotty *in chat* to "like every message".
That requires a **gateway-level capability** Scotty cannot self-install from a WhatsApp
chat (gateway hooks, secrets, channels are fenced off for safety — see `SKILL.md` rule
#8). Scotty neither built it nor clearly explained why, so it looked broken.

Root cause for both: **acknowledgment is being asked of the LLM, which is non-deterministic.
It must move below the LLM, to the gateway.**

## Goal

Every inbound message from David in the **Job Scout group** receives a 👍 reaction
**immediately and reliably**, independent of the LLM (even when the model is slow,
busy, or errors out). Plus: when David asks in chat for something Scotty cannot do from
chat, Scotty says so plainly instead of failing silently.

## Decision

Use a **deterministic OpenClaw gateway hook** on the internal `message:received` event.
A handler reacts 👍 to the inbound message via `openclaw message react`. The LLM is no
longer responsible for acknowledgment; the 👀→✅ instructions are removed.

Reactions to group messages via the CLI are already proven to work (gateway logs show
successful `Sent reaction "👀"/"✅"/"👍"` entries on group messages).

### Why a hook (Approach A), not the alternatives

- **A — Gateway hook (chosen):** fires on `message:received`, ~1s, 100% reliable,
  LLM-independent. Handler module lives under `workspace/` and is referenced from config,
  so it **survives `openclaw` upgrades** (same upgrade-proofing pattern as the existing
  `agents.defaults.cliBackends` fix in `~/.openclaw/openclaw.json`).
- **B — Prompt-only ("react 👍 first, always"):** zero infra, but still LLM-dependent →
  keeps skipping. Rejected: it is the exact thing already failing.
- **C — Journal-watcher sidecar:** tails the gateway log and reacts. Fragile, race-prone,
  no clean message-id. Rejected.

## The `message:received` hook event (verified)

OpenClaw 2026.5.22 fires internal hook events. `MessageReceivedHookContext`
(`dist/internal-hooks-*.d.ts`) carries everything needed:

| Field | Use |
|---|---|
| `channelId` | filter to WhatsApp |
| `conversationId` | the group/chat id — react target + group filter |
| `messageId` | the message to react to |
| `from` / `senderId` | sender (available on `message:preprocessed`) |
| `content`, `timestamp`, `accountId`, `metadata` | unused for now |

Hooks register via `hooks.internal.handlers` in config: `{ "event": "message:received",
"module": "<path>" }` (per the bundled `command-logger` handler's own documentation).

## Components

### 1. Hook handler — `workspace/tools/hooks/ack-react.mjs` (new)

- Exports a handler for the `message:received` event.
- **Filters** (react only when ALL hold):
  - `channelId === "whatsapp"`
  - `conversationId === <group_id>` from `workspace/.config/job-scout.json#whatsapp.group_id`
    — enforces hard rule #1 (only ever touch the configured group).
  - `messageId` is present.
- **Action:** shell out to
  `openclaw message react --channel whatsapp --target <group_id> --message-id <messageId> --emoji 👍`.
  - Shelling the CLI (vs. importing internal modules) is chosen for **upgrade stability** —
    internal module paths change between releases; the CLI surface is stable.
- **Error handling:** all failures are caught and logged only. The handler must NEVER
  throw or block message processing (a failed 👍 must not stop Scotty from replying).
- **Idempotency/noise:** one 👍 per inbound message. No retraction, no ✅ follow-up.
- Reads `group_id` fresh from config (no hard-coded id).

### 2. Config registration — `~/.openclaw/openclaw.json` (edit)

Add under `hooks.internal.handlers` an entry pointing at the absolute path of
`ack-react.mjs`, with the bundled hooks left intact. This is the upgrade-proof wiring
(handler lives in `workspace/`, only a reference lives in config).

### 3. Prompt cleanup (edit) — remove dead LLM-reaction instructions

- `skills/job-scout/SKILL.md` — drop the "react 👀 … ✅" clause in *Mode routing* and the
  "React (working/done indicator)" tool-table row.
- `skills/job-scout/prompt-qa.md` — delete the entire "Working on it" indicator section.
- Replace with a one-line note: *"Acknowledgment (👍 on every inbound message) is handled
  automatically by the `ack-react` gateway hook — do NOT react from the prompt."*

### 4. Self-capability honesty (edit) — `skills/job-scout/SKILL.md` rule #8

Append to rule #8: when David asks in chat for something that requires a dev session
(gateway hooks, secrets, OAuth scopes, new channels, watchdog/infra), Scotty must
**reply plainly in Hebrew** that it cannot wire that from chat and it needs a dev
session — never silently do nothing. Rule #8's plan-then-approve flow for self-edits of
its own prompt/skill files is **unchanged** (David chose not to loosen it).

## Out of scope (YAGNI)

- No ✅ "done" reaction, no 👀 "working" reaction — David chose a single 👍 receipt.
- No loosening of rule #8 self-edit gating.
- No ability for Scotty to self-install gateway capabilities from chat (security boundary,
  intentionally kept).
- No reaction in the daily cron scout path (that is not an inbound user message).

## Testing / verification

1. **Handler unit-ish check:** invoke the handler module directly with a fake
   `message:received` event for the group → asserts it calls react with the right
   args (use `--dry-run` on the react CLI to avoid sending).
2. **Filter check:** fake events for a non-WhatsApp channel and a wrong `conversationId`
   → handler does NOT react.
3. **Live check:** send a WhatsApp message to the Job Scout group → 👍 appears within
   ~1–2s; gateway log shows `Sent reaction "👍" -> message <id>`; Scotty's text reply
   still arrives; no `message:received` hook errors in the journal.
4. **Upgrade-survival reasoning:** confirm the handler file is under `workspace/` and only
   referenced (not copied) from config, so `npm i -g openclaw` cannot wipe it.

## Risks

- **CLI shell-out latency** (~1–2s, spawns a node process). Acceptable for a 👍.
- **react needs `--participant` in some group setups:** logs show group reactions already
  succeed with just `--target <group_id> --message-id`, so not expected — but the live
  check (step 3) confirms it. If it fails, add `--participant <senderId>` from the
  `message:preprocessed` context.
- **Hook handler module resolution:** the exact module-path format accepted by
  `hooks.internal.handlers` must be confirmed during implementation (absolute path vs.
  relative-to-config). Fallback: a thin bundled-style `HOOK.md`+`handler.js` pack under
  `workspace/` referenced by directory.
