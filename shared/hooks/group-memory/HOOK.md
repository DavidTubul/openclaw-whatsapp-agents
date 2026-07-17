---
name: group-memory
description: "Inject each agent's LEARNED group memory (who the members are, the humor, the dynamics) into its AGENTS.md at bootstrap — shared, multi-agent"
metadata:
  {
    "openclaw":
      {
        "events": ["agent:bootstrap"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Group-Memory Hook (shared, multi-agent)

Folds each agent's **learned** group memory into its system prompt at bootstrap, so every bot wakes
up already knowing the people, the humor and the in-jokes of its group — like someone who's been
around a while, not a stranger who resets every session.

## What it does

1. Fires on `agent:bootstrap`.
2. Resolves the owning agent from `event.context.agentId` via `getAgent()`. Unregistered → silent no-op.
3. Reads that agent's `data/memory/group-notes.md` (via `shared/lib/group-memory.mjs`). Empty/missing
   → injects nothing.
4. **Appends** the wrapped memory block to the agent's `AGENTS.md` bootstrap entry (in-place mutation
   of `event.context.bootstrapFiles`, same mechanism as `group-reply-policy`).

## Where the memory comes from

`data/memory/group-notes.md` is rewritten periodically by **`shared/tools/reflect.mjs --agent <id>`**
(run from a daily systemd timer), which reads the recent chat-log + the current notes and asks the
model to update a concise per-member + group-vibe profile. Because the memory is a FILE, it survives
session resets and crashes; the bot re-loads it on every bootstrap.

## Why a hook

Only the six bootstrap files are auto-injected; this keeps the learned memory always-on (in
`AGENTS.md`) from a single shared code path, with zero per-workspace duplication.

Independent of the conversational LLM at inject time. **Never throws** — a memory-injection failure
must never break bootstrap. Disable: `openclaw hooks disable group-memory`.
