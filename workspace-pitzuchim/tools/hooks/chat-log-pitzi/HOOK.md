---
name: chat-log-pitzi
description: "Mirror every group message into an append-only chat-log + RECENT_CHAT.md, and capture inbound media refs for the complaint workflow"
metadata:
  {
    "openclaw":
      {
        "events": ["message:received", "message:sent"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Chat-Log Hook (פיצי)

Appends every inbound/outbound WhatsApp message in the חנות הפיצוחים group to an
append-only record (`workspace-pitzuchim/data/chat-log/<group>.jsonl`, full audit) and
regenerates a lean `workspace-pitzuchim/RECENT_CHAT.md` (last N exchanges). Independent of
the LLM, so recent context survives session resets.

## Extra: inbound media capture (for the freshness-complaint workflow)

Unlike the other agents' chat-log, this one ALSO:
- logs **media-only** messages (a photo with no caption), and
- writes a best-effort `media[]` array into `data/last-inbound.json`, probing common event
  shapes (`attachments` / `media` / `metadata.*`).

The complaint prompt's primary mechanism is still scanning `~/.openclaw/media/inbound/` by
mtime (robust regardless of event shape) — this just adds correlation when the event carries
media refs. Inbound speaker = "לקוח", outbound = "פיצי".

## Disabling

```bash
openclaw hooks disable chat-log-pitzi
```
