// shared/hooks/ack-react/handler.js
//
// Single shared 👍 deterministic-ack hook for ALL OpenClaw agents.
//
// Replaces the five per-bot copies under workspace-*/tools/hooks/ack-react*/handler.js.
// Behaviour is preserved exactly; the only per-agent variation (which group ids belong
// to which bot) is resolved at runtime from the central agent registry instead of being
// hardcoded / read from each bot's .config/bot.json.
//
// Flow:
//   1. Resolve the owning agent from ctx.conversationId via getAgentByGroup().
//      No owning agent (or not a WhatsApp message event) -> silent no-op. This also excludes
//      any listen-only group, which is deliberately absent from the registry groupIds.
//   2. decideAck(event, agent)  [pure] — combines: agent.ackReact.enabled (default true),
//      message validity + group scoping (decideReaction), and scope (default "mentions":
//      the message must be addressed to the bot via its wake-word; "all": every inbound).
//   3. runReact(decision)       [side-effecting, never throws]
//
// Owner policy (2026-07-15): all five agents ack a message ADDRESSED TO them (wake-word),
// registry-scoped groups only; never in the listen-only group.
//
// Never throws — a failed acknowledgment must not break the pipeline.

import { getAgentByGroup } from "../../lib/agent-registry.mjs";
import { decideAck, runReact } from "../../lib/ack-react.mjs";

// TEMP DIAGNOSTIC (2026-07-15, remove once 👍-acks verified on live traffic): logs every
// invocation for a registry-owned conversation so /tmp/openclaw/openclaw-<date>.log shows
// where the ack chain stops in production. One line per registered-group message — low volume.
function dbg(...args) {
  try {
    console.log("[ack-react]", ...args);
  } catch {}
}

/** Hook entry point — never throws; a failed 👍 must not block message processing. */
export default async function ackReact(event) {
  try {
    const ctx = event?.context ?? {};
    // Resolve which agent owns the conversation this message arrived in.
    // getAgentByGroup matches primaryGroupId OR any groupIds entry (digit's
    // secondary group resolves to digit). If no agent owns it, no-op.
    const agent = ctx.conversationId ? getAgentByGroup(ctx.conversationId) : null;
    if (!agent) return;

    // The pure decision consults the agent's ackReact policy + wake-word addressing, and reacts
    // in whichever of the agent's groups the message actually came from (digit serves several).
    const decision = decideAck(event, agent);
    // wasMentioned is the explicit mention/quote-reply flag the vendored WhatsApp emit now supplies
    // (patch #4 `[inbound-hook-mention]`); logging it shows the addressing-decision input for audits
    // (quote-replies carry no wake word but arrive here as wasMentioned=true → acked).
    dbg(
      `agent=${agent.agentId} conv=${ctx.conversationId} type=${event?.type}:${event?.action}`,
      `wasMentioned=${JSON.stringify(ctx.wasMentioned ?? ctx.metadata?.wasMentioned)}`,
      `content=${JSON.stringify(typeof ctx.content === "string" ? ctx.content.slice(0, 60) : ctx.content)}`,
      `decision=${JSON.stringify(decision)}`,
    );
    if (!decision.react) return;

    const result = await runReact(decision);
    dbg(
      `runReact done agent=${agent.agentId} err=${result?.err ? (result.err.code ?? result.err.signal ?? String(result.err)) : null}`,
      `stdout=${JSON.stringify((result?.stdout ?? "").trim().slice(0, 120))}`,
      `stderr=${JSON.stringify((result?.stderr ?? "").trim().slice(0, 120))}`,
    );
  } catch (err) {
    dbg(`swallowed error: ${err?.message ?? err}`);
    // swallow — acknowledgment is best-effort and must never break the pipeline
  }
}
