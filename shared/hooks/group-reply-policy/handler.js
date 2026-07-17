// shared/hooks/group-reply-policy/handler.js
//
// Single shared bootstrap hook for ALL OpenClaw agents. At `agent:bootstrap`
// it folds the shared group-reply policy (the SINGLE source of truth in
// shared/lib/reply-policy.mjs) into the agent's AGENTS.md system-prompt entry,
// replacing the hand-copied policy prose that used to live in each
// workspace-*/AGENTS.md.
//
// Flow:
//   1. Resolve the agent from event.context.agentId via getAgent().
//      No registered agent -> silent no-op.
//   2. policy = buildPolicyText(agentCfg)              [pure]
//   3. Find the AGENTS.md entry in event.context.bootstrapFiles and APPEND the
//      policy to its .content (reading the file at .path first if .content is
//      absent). Mutate the array in place — the dispatcher reads it back.
//
// Never throws — a throw here must NOT break bootstrap.

import { readFileSync } from "node:fs";
import path from "node:path";

import { getAgent } from "../../lib/agent-registry.mjs";
import { buildPolicyText } from "../../lib/reply-policy.mjs";

/** Hook entry point — never throws; a policy-injection failure must not break bootstrap. */
export default async function groupReplyPolicy(event) {
  try {
    const ctx = event?.context ?? {};

    // Resolve which agent is bootstrapping. No registered agent -> no-op.
    const agent = ctx.agentId ? getAgent(ctx.agentId) : null;
    if (!agent) return;

    const files = ctx.bootstrapFiles;
    if (!Array.isArray(files)) return;

    // Build the policy block once (pure, persona-neutral, owner label from record).
    const policy = buildPolicyText(agent);
    if (!policy) return;

    // Find the AGENTS.md entry (recognized injected basename, home of always-on rules).
    const agentsEntry = files.find((f) => {
      const p = f && (f.path || f.name);
      if (!p) return false;
      return path.basename(String(p)) === "AGENTS.md";
    });
    if (!agentsEntry) return;

    // Append to its content; read the file off disk if no inline content yet.
    let base;
    if (typeof agentsEntry.content === "string") {
      base = agentsEntry.content;
    } else if (agentsEntry.path) {
      try {
        base = readFileSync(agentsEntry.path, "utf8");
      } catch {
        return; // can't read the file -> leave bootstrap untouched
      }
    } else {
      return;
    }

    agentsEntry.content = base + "\n\n" + policy;
  } catch {
    // swallow — policy injection is best-effort and must never break bootstrap
  }
}
