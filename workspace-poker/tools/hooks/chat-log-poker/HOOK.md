---
name: chat-log-poker
description: "Mirror every poker-group message into an append-only chat-log + RECENT_CHAT.md (continuity across session resets)"
metadata:
  {
    "openclaw":
      {
        "events": ["message:received", "message:sent"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Chat-Log Hook (poker)

Appends every inbound/outbound WhatsApp message in the poker group to an append-only record
(`workspace-poker/data/chat-log/<group>.jsonl`, never trimmed) and regenerates a lean
`workspace-poker/RECENT_CHAT.md` (last N exchanges, דילר replies truncated). Independent of the LLM,
so recent context survives session resets.

Multi-player: inbound sender names are resolved best-effort from `data/players.json` (by e164) so the
log reads "דני: …" rather than a raw number. Also writes `data/last-inbound.json`
(`{e164, fromMe, speaker, messageId}`) so the agent can attribute "me/אני" and issue quoted replies.
Only ever the configured group; no-ops while `group_id` is unset. Disable: `openclaw hooks disable chat-log-poker`.
