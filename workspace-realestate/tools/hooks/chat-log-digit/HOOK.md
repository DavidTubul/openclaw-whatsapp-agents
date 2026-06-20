---
name: chat-log-digit
description: "Mirror every group message into an append-only chat-log + RECENT_CHAT.md (continuity across session resets)"
metadata:
  {
    "openclaw":
      {
        "events": ["message:received", "message:sent"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Chat-Log Hook

Appends every inbound/outbound WhatsApp message in the נדל"ן US group to an append-only
record (`workspace-realestate/data/chat-log/<group>.jsonl`, never trimmed — full audit) and
regenerates a lean `workspace-realestate/RECENT_CHAT.md` (last N exchanges, דיגיט replies
truncated). Independent of the LLM, so recent context survives session resets (see
session-hygiene). Single-user bot: inbound = David, outbound = דיגיט. Only ever the configured
group. Disable: `openclaw hooks disable chat-log`.
