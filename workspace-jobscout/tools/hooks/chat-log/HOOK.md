---
name: chat-log
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

Appends every inbound/outbound WhatsApp message in the Job Scout group to an append-only
record (`workspace/data/chat-log/<group>.jsonl`, never trimmed — full audit) and regenerates
a lean `workspace/RECENT_CHAT.md` (last N exchanges, Scotty replies truncated). Independent of
the LLM, so recent context survives session resets (see session-hygiene). Enforces hard rule #1
(only ever the configured group). Disable: `openclaw hooks disable chat-log`.
