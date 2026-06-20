---
name: ack-react-poker
description: "React 👍 to every inbound WhatsApp message in the poker group"
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

# Ack-React Hook (poker)

Deterministically reacts 👍 to every inbound WhatsApp message in the configured poker group,
the instant it is received — independent of the LLM (which skips reactions under load).

## What it does

1. Fires on the internal `message:received` event.
2. Filters: `channelId === "whatsapp"` AND `conversationId === whatsapp.group_id`
   (from `workspace-poker/.config/bot.json`) AND `messageId` present. Only ever touches that group.
   (No-ops while `group_id` is unset.)
3. Shells `openclaw message react … --emoji 👍`. Errors are swallowed (best-effort).

## Configuration

Registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` pointing at
`workspace-poker/tools/hooks`. No other config needed. Disable: `openclaw hooks disable ack-react-poker`.
