// shared/lib/ack-react.mjs
// Unified 👍 deterministic-ack logic for ALL OpenClaw agents.
//
// Behaviour is factored out of the five per-bot copies under
// workspace-*/tools/hooks/ack-react*/handler.js. It is byte-for-byte equivalent
// to those copies, with the only per-agent variation expressed as parameters:
//   - the configured group id(s): a single string OR an array (realestate/digit
//     serves several groups and must react in whichever one the message came from).
//   - the launcher path + emoji (constant across all bots today, but parameterised
//     so a future bot can override without forking this file).
//
// The two PURE pieces are exported and unit-tested:
//   decideReaction(event, groupIdOrIds)  -> { react, target, messageId, participant, fromMe, reason }
//   buildReactArgs(decision, { emoji?, dryRun? }) -> argv array for `openclaw message react`
//
// The side-effecting runner is exported separately so a hook can wire it up.

import { execFile } from "node:child_process";
import { launcherPath } from "./paths.mjs";

// Repo-root launcher — the ONE derivation now lives in shared/lib/paths.mjs. Re-exported here as
// DEFAULT_LAUNCHER for the hook consumers/tests that import it from this module.
export const DEFAULT_LAUNCHER = launcherPath;
export const DEFAULT_EMOJI = "👍";

/**
 * Pick the first non-empty, trimmed string from a list of candidates.
 * (Matches `pickParticipant` in every original handler.)
 */
export function pickParticipant(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

/**
 * Pure decision function: should we react to this event, and with what
 * target/message/participant/fromMe?
 *
 * Only WhatsApp `message:received` events in a configured group, with a messageId.
 * `groupIdOrIds` may be a single id (string) or an array of ids — an agent may
 * serve several groups (digit/realestate). We react in the group the message
 * ACTUALLY came from (`ctx.conversationId`), which for the single-id case is
 * identical to that id.
 *
 * Notes preserved from the originals:
 *  - A GROUP reaction key must match the original message exactly or WhatsApp
 *    accepts it ("Sent reaction") but never renders it. Two parts:
 *      participant: the sender's JID. `ctx.from` is the GROUP jid here, not the
 *        sender, so we take it from metadata.senderId / senderE164.
 *      fromMe: the bot runs ON David's own WhatsApp account (account number ==
 *        sender number), so David's own messages are fromMe:true. We must set
 *        that, else the key (which defaults fromMe:false) won't match his message.
 */
export function decideReaction(event, groupIdOrIds) {
  const no = (reason) => ({ react: false, reason });
  if (!event || event.type !== "message") return no("not a message event");
  if (event.action !== "received") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  const ids = Array.isArray(groupIdOrIds)
    ? groupIdOrIds
    : (groupIdOrIds ? [groupIdOrIds] : []);
  if (!ids.includes(ctx.conversationId)) return no(`conversation=${ctx.conversationId}`);
  if (!ctx.messageId) return no("no messageId");
  const meta = ctx.metadata ?? {};
  const ownE164 = typeof meta.to === "string" ? meta.to.trim() : undefined;
  const senderE164 = pickParticipant(meta.senderE164, meta.senderId);
  const participant = pickParticipant(meta.senderId, meta.senderE164);
  const fromMe = !!(ownE164 && senderE164 && senderE164 === ownE164);
  // React in the group the message actually came from (not necessarily the primary).
  return {
    react: true,
    target: ctx.conversationId,
    messageId: ctx.messageId,
    participant,
    fromMe,
    reason: "ok",
  };
}

/**
 * Is this inbound message ADDRESSED TO the bot (so it warrants an acknowledgment 👍)?
 *
 * Owner policy (2026-07-15): every agent acks a message that calls it — not every group chatter.
 *  - scope "all"      : always addressed (react to every inbound in the agent's registry groups).
 *  - scope "mentions" : (default) addressed when the message calls the bot. Detection order:
 *      1. an EXPLICIT mention/activation flag on the internal event context, if the mapper ever
 *         provides one (`ctx.wasMentioned` / `ctx.metadata.wasMentioned` / `…activation`) — preferred;
 *      2. otherwise a wake-word match: the trimmed message text CONTAINS the agent's Hebrew
 *         persona name as a substring. Hebrew names have no ASCII word boundaries, so a plain
 *         `includes()` (whitespace-trimmed) is the right, punctuation-tolerant test.
 *
 * Pure + never throws. `wakeWord` is the agent's persona.name; `scope` defaults to "mentions".
 * (As of 2026-07-17 the internal-hook context DOES carry the flag in production: vendored patch #4's
 * WhatsApp emit — `emitWhatsAppMessageReceivedHooks`, marker `[inbound-hook-mention]` — enriches the
 * internal ctx metadata with `meta.wasMentioned` (from the core `ctxPayload.WasMentioned`, itself
 * `msg.groupMention.wasMentioned`) plus the `replyTo*` fields. So a quote-reply to the bot's own
 * message — which contains NO wake word but IS a mention — now arrives with `meta.wasMentioned === true`
 * and is acked via the explicit-flag branch below. The stock core mapper still maps neither field, so
 * without that vendored enrichment only the wake-word path would run; keep them in sync.)
 */
export function isAddressedToAgent(event, { wakeWord, scope = "mentions" } = {}) {
  if (scope === "all") return true;
  const ctx = event?.context ?? {};
  const meta = ctx.metadata ?? {};
  const explicit = ctx.wasMentioned ?? meta.wasMentioned ?? ctx.activation ?? meta.activation;
  if (typeof explicit === "boolean") return explicit; // prefer an explicit flag when present
  if (typeof wakeWord !== "string" || !wakeWord.trim()) return false;
  const text = typeof ctx.content === "string" ? ctx.content : "";
  return text.includes(wakeWord.trim());
}

/**
 * Full ack decision for a resolved agent: combine enablement + message validity + addressed-to-bot.
 * Registry-driven `agent.ackReact` block: { enabled?: boolean (default true), scope?: "mentions"
 * | "all" (default "mentions") }. Returns the same shape as decideReaction (so the caller can pass
 * it straight to runReact), with react:false + a reason when we must NOT ack.
 *
 *  - enabled === false                       → no-op (explicit opt-out).
 *  - message not valid/in-group (decideReaction) → no-op, carrying decideReaction's reason.
 *  - scope "mentions" and not addressed to us → no-op ("not addressed").
 *  - otherwise                                → react (with target/messageId/participant/fromMe).
 *
 * Pure; never throws. Group scoping (incl. excluding a listen-only group that is absent from the
 * registry groupIds) is inherited from decideReaction.
 */
export function decideAck(event, agent) {
  const no = (reason) => ({ react: false, reason });
  if (!agent) return no("no agent");
  const ack = agent.ackReact ?? {};
  if (ack.enabled === false) return no("ackReact disabled");
  const scope = ack.scope ?? "mentions";
  const base = decideReaction(event, agent.groupIds);
  if (!base.react) return base;
  if (!isAddressedToAgent(event, { wakeWord: agent.persona?.name, scope })) {
    return no("not addressed to agent");
  }
  return base;
}

/**
 * Pure builder for the `openclaw message react` argv — kept separate so it can
 * be unit-tested. Identical flag order/shape to every original handler.
 */
export function buildReactArgs(
  { target, messageId, participant, fromMe },
  { emoji = DEFAULT_EMOJI, dryRun = false } = {},
) {
  const args = [
    "message", "react", "--channel", "whatsapp",
    "--target", target, "--message-id", messageId, "--emoji", emoji,
  ];
  if (participant) args.push("--participant", participant);
  if (fromMe) args.push("--from-me");
  if (dryRun) args.push("--dry-run");
  return args;
}

/**
 * Side-effecting runner: shells out to the launcher to send the reaction.
 * Never throws (resolves with {err,stdout,stderr}); a failed 👍 must not block
 * message processing. Honours ACK_REACT_DRY_RUN for dry runs (same env var the
 * originals used).
 *
 * Accepts an options bag so a per-agent hook may override launcher/emoji; both
 * default to the values every current bot uses.
 */
export function runReact(
  { target, messageId, participant, fromMe },
  // timeout: the CLI child takes ~5-6.5s to boot even on an idle box (bash wrapper sources nvm,
  // then a full node CLI start). During scout hours the gateway also runs up to 5 parallel agent
  // children, so a 15s budget gets the child SIGTERMed before the reaction is sent — observed as
  // silently missing 👍s on 2026-07-15. 60s keeps the ack best-effort without hanging the hook.
  { launcher = DEFAULT_LAUNCHER, emoji = DEFAULT_EMOJI, timeout = 60000 } = {},
) {
  const args = buildReactArgs(
    { target, messageId, participant, fromMe },
    { emoji, dryRun: !!process.env.ACK_REACT_DRY_RUN },
  );
  return new Promise((resolve) => {
    execFile(launcher, args, { timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}
