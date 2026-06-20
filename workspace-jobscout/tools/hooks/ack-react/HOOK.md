---
name: ack-react
description: "React 👍 to every inbound WhatsApp message in the Job Scout group"
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

# Ack-React Hook

Deterministically reacts 👍 to every inbound WhatsApp message in the configured
Job Scout group, the instant it is received — independent of the agent/LLM.

## Why

The LLM-driven acknowledgment (👀→✅) was unreliable: the conversational model skipped
reactions under load. This hook moves acknowledgment below the LLM so David always sees
that his message was received.

## What it does

1. Fires on the internal `message:received` event.
2. Filters: `channelId === "whatsapp"` AND `conversationId === whatsapp.group_id`
   (from `workspace/.config/job-scout.json`) AND `messageId` present.
   (Enforces hard rule #1 — only ever touches the configured group.)
3. Shells `openclaw message react … --emoji 👍`. Errors are swallowed (best-effort).

## Configuration

Registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` pointing at
`workspace/tools/hooks` (the parent dir of this pack). No other config needed.

## Disabling

```bash
openclaw hooks disable ack-react
```
