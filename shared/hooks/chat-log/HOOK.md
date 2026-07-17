---
name: chat-log
description: "Mirror every group message into the owning agent's append-only chat-log + RECENT_CHAT.md (continuity across session resets) — shared, multi-agent"
metadata:
  {
    "openclaw":
      {
        "events": ["message:received", "message:sent"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Chat-Log Hook (shared, multi-agent)

One hook for all five OpenClaw agents (Scotty/דיגיט/דאוס/פיצי/זורו). On every inbound/outbound
WhatsApp message it resolves **which** agent owns the conversation (by group jid, via the central
agent registry `shared/lib/agent-registry.mjs`) and delegates to the shared chat-log lib
`shared/lib/chat-log.mjs`:

- appends the message to **that** bot's `data/chat-log/<group>.jsonl` (append-only, never trimmed —
  full audit), keyed off the group the message actually came from (digit's two groups stay separate);
- regenerates that bot's lean `RECENT_CHAT.md` (last N exchanges, bot replies truncated) so recent
  context survives session resets (see session-hygiene);
- writes that bot's `data/last-inbound.json` (sender id for Q&A routing; shape varies by roster type).

Per-agent parameters (labels, roster, e164 normalization, media refs + Google-Sheet mirror for פיצי,
daily-scout collapse for Scotty) are derived from the registry in `agent-cfg.mjs` — no per-workspace
duplication. A conversation belonging to no registered agent is a silent no-op.

Independent of the LLM. **Never throws** — a chat-log failure can never block message processing.
Disable: `openclaw hooks disable chat-log`.
