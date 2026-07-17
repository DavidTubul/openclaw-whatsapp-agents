// shared/hooks/chat-log/handler.js
//
// UNIFIED chat-log gateway hook for all five OpenClaw agents. Replaces the five duplicated
// workspace-*/tools/hooks/chat-log-*/handler.js copies. One hook, registered once on the shared
// gateway: on every message:received / message:sent it resolves WHICH agent the message belongs to
// (by the conversation/group jid, via the central agent registry), builds that agent's chat-log
// config, and delegates to the shared chat-log lib — which logs to THAT bot's
// data/chat-log/<group>.jsonl, regenerates its RECENT_CHAT.md, and writes its last-inbound.json.
//
// Behavior preserved exactly per bot (labels, roster, e164 normalization, media + Sheet mirror for
// pitzi, scout collapse for jobscout) — all parameterized in agent-cfg.mjs from the registry.
//
// Never throws: a chat-log failure must never block message processing.

import { getAgentByGroup } from "../../lib/agent-registry.mjs";
import writeLog from "../../lib/chat-log.mjs";
import { agentCfgFromRecord } from "./agent-cfg.mjs";

/**
 * Resolve the agent that owns the conversation an event came from. Pure (registry is loaded once,
 * indexed in memory). Returns the agentCfg, or null when the conversation belongs to no agent.
 */
export function resolveAgentCfg(event) {
  const conv = event?.context?.conversationId;
  if (!conv) return null;
  const rec = getAgentByGroup(conv);
  if (!rec) return null;
  return agentCfgFromRecord(rec);
}

/** Hook entry — never throws. */
export default async function chatLog(event) {
  try {
    const cfg = resolveAgentCfg(event);
    if (!cfg) return; // not one of our groups → no-op
    await writeLog(event, cfg); // writeLog is itself best-effort / never-throws
  } catch {
    // belt-and-suspenders: a chat-log failure must never block message processing
  }
}
