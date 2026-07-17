---
name: ack-react
description: "React 👍 to inbound WhatsApp messages addressed to the owning agent (wake-word) in its registered groups"
metadata:
  {
    "openclaw":
      {
        "emoji": "👍",
        "events": ["message:received"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Ack-React Hook (shared, multi-agent)

Deterministically reacts 👍 to an inbound WhatsApp message that is **addressed to** the owning
agent — the instant it is received, independent of the agent/LLM.

**Ack policy (owner decision, 2026-07-15):** all five agents acknowledge a message that *calls*
them (their wake-word), not every group chatter. This is registry-driven per agent via an optional
`ackReact` block: `{ enabled?: boolean (default true), scope?: "mentions" | "all" (default
"mentions") }`.
- `scope: "mentions"` (default) — react only when the message is addressed to the bot: an explicit
  mention flag on the event if the core ever provides one (none today), else the trimmed message
  text **contains the agent's Hebrew persona name** (wake-word) as a substring.
- `scope: "all"` — react to every inbound in the agent's groups (no agent uses this today; kept
  supported).
- `enabled: false` — the agent opts out of acks entirely.

Acks are always **registry-group-scoped**: only within the owning agent's `groupIds`, which
deliberately **excludes** any listen-only group (absent from the registry), so the "silent" group is
never acked. `channels.whatsapp.ackReaction.group` stays `"never"` (this hook is the one source of
group 👍s; DM ack stays native).

This is the **single shared** replacement for the five per-bot copies that previously lived
under `workspace-*/tools/hooks/ack-react*/handler.js`. The per-agent variation (which group ids
belong to which bot, the wake-word, and the ack policy) is resolved at runtime from the central
agent registry.

## Why

The LLM-driven acknowledgment (👀→✅) was unreliable: the conversational model skipped
reactions under load. This hook moves acknowledgment below the LLM so the sender always sees
that their message was received.

## What it does

1. Fires on the internal `message:received` event.
2. Resolves the owning agent from `ctx.conversationId` via
   `shared/lib/agent-registry.mjs` `getAgentByGroup()`. If no agent owns that group
   (or it isn't a WhatsApp message event), it is a silent no-op. This enforces the
   isolation guarantee: the hook only ever touches groups wired to a registered agent.
3. Delegates the whole decision to `shared/lib/ack-react.mjs` `decideAck(event, agent)` (pure),
   which combines: the agent's `ackReact` policy (`enabled` default true, `scope` default
   "mentions"), message validity + group scoping (`decideReaction`, using **that agent's**
   `groupIds` so we react in whichever group the message actually came from), and — for
   `scope:"mentions"` — the addressed-to-bot test (`isAddressedToAgent`, wake-word = persona name).
4. On a positive decision, shells `openclaw message react … --emoji 👍` via `runReact`.
   Errors are swallowed (best-effort) — a failed 👍 must never block message processing.

## Configuration

Registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` pointing at
`shared/hooks` (the parent dir of this pack). The group→agent mapping comes from
`shared/registry.json`; no per-hook config is needed.

Honours `ACK_REACT_DRY_RUN` (same env var the originals used) for dry runs.

## Disabling

```bash
openclaw hooks disable ack-react
```
