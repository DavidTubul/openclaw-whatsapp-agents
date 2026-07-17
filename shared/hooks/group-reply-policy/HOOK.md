---
name: group-reply-policy
description: "Inject the shared group-reply policy into every agent's AGENTS.md at bootstrap (single source of truth) — shared, multi-agent"
metadata:
  {
    "openclaw":
      {
        "events": ["agent:bootstrap"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Group-Reply-Policy Hook (shared, multi-agent)

Injects the **single** source-of-truth group-reply policy (bundled messages, sender
tagging, auto-quote/no-double-send) into **every** OpenClaw agent's system prompt at
bootstrap, instead of each `workspace-*/AGENTS.md` carrying its own hand-copied wording.

This replaces the duplicated policy prose that previously lived inline in each bot's
`AGENTS.md`. The persona-neutral policy text comes from `shared/lib/reply-policy.mjs`
`buildPolicyText(agentCfg)`; the only per-agent variation (owner label) is read from the
agent record resolved via `shared/lib/agent-registry.mjs`.

## What it does

1. Fires on the internal `agent:bootstrap` event.
2. Resolves the owning agent from `event.context.agentId` via `getAgent()`. If the agent
   is not registered, it is a silent no-op.
3. Builds the policy markdown via `buildPolicyText(agentCfg)`.
4. **Appends** the policy to the agent's `AGENTS.md` bootstrap entry inside
   `event.context.bootstrapFiles`:
   - finds the entry whose basename is `AGENTS.md`;
   - if that entry already has a `.content` string, sets `.content = content + "\n\n" + policy`;
   - if `.content` is absent, reads the file at `.path`, then sets `.content` to
     `(fileText + "\n\n" + policy)`.
   The `bootstrapFiles` array is mutated **in place** — the dispatcher reads it back.

It never pushes a *new* bootstrap file: OpenClaw only injects the recognized basenames
(`AGENTS/SOUL/IDENTITY/USER/TOOLS/HEARTBEAT/BOOTSTRAP/MEMORY.md`), so the policy must ride
inside one of them — `AGENTS.md` is the home of always-on rules.

## Why a hook

Only the six bootstrap files are auto-injected; `SKILL.md`/`prompt-*.md`/`CLAUDE.md` are
read on demand. Keeping the policy in one shared lib and folding it in at bootstrap means
the wording lives **once** and every bot stays in lock-step, with no per-workspace copy to
drift.

## Configuration

Registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` pointing at
`shared/hooks` (the parent dir of this pack). The agent→owner mapping comes from
`shared/registry.json`; no per-hook config is needed.

Independent of the LLM. **Never throws** — a policy-injection failure must never break
bootstrap. Disable: `openclaw hooks disable group-reply-policy`.
