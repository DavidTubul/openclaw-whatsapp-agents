---
name: ack-react-pitzi
description: "React 👍 to every inbound WhatsApp message in the חנות הפיצוחים customer-service group"
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

# Ack-React Hook (פיצי)

Deterministically reacts 👍 to every inbound WhatsApp message in the configured
חנות הפיצוחים group, the instant it is received — independent of the agent/LLM. So a
customer always sees their message was received, even before פיצי composes a reply.

## What it does

1. Fires on the internal `message:received` event.
2. Filters: `channelId === "whatsapp"` AND `conversationId === whatsapp.group_id`
   (from `workspace-pitzuchim/.config/bot.json`) AND `messageId` present.
3. Shells `openclaw message react … --emoji 👍`. Errors swallowed (best-effort).

## Configuration

Registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` pointing at
`workspace-pitzuchim/tools/hooks`. Hook name suffixed `-pitzi` to avoid colliding with the
other agents' `ack-react` / `ack-react-digit`.

## Disabling

```bash
openclaw hooks disable ack-react-pitzi
```
