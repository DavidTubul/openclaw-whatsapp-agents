import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const LAUNCHER = "/home/davidtobol2580/open_claw/openclaw";
const CONFIG_PATH = "/home/davidtobol2580/open_claw/workspace-poker/.config/bot.json";
const EMOJI = "👍";

/**
 * Pure decision function: should we react to this event, and with what target/message?
 * Only WhatsApp `message:received` events in the configured poker group, with a messageId.
 */
export function decideReaction(event, groupId) {
  const no = (reason) => ({ react: false, reason });
  if (!event || event.type !== "message") return no("not a message event");
  if (event.action !== "received") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  if (!groupId || ctx.conversationId !== groupId) return no(`conversation=${ctx.conversationId}`);
  if (!ctx.messageId) return no("no messageId");
  // A GROUP reaction key must match the original message exactly. `ctx.from` is the GROUP jid,
  // so the sender comes from metadata. fromMe: this bot runs on David's own WhatsApp account, so
  // his own messages are fromMe:true and the reaction key must reflect that to render.
  const meta = ctx.metadata ?? {};
  const ownE164 = typeof meta.to === "string" ? meta.to.trim() : undefined;
  const senderE164 = pickParticipant(meta.senderE164, meta.senderId);
  const participant = pickParticipant(meta.senderId, meta.senderE164);
  const fromMe = !!(ownE164 && senderE164 && senderE164 === ownE164);
  return { react: true, target: groupId, messageId: ctx.messageId, participant, fromMe, reason: "ok" };
}

function pickParticipant(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

async function resolveGroupId() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw)?.whatsapp?.group_id;
}

/** Pure builder for the `openclaw message react` argv — kept separate so it can be unit-tested. */
export function buildReactArgs({ target, messageId, participant, fromMe }, { dryRun = false } = {}) {
  const args = ["message", "react", "--channel", "whatsapp",
    "--target", target, "--message-id", messageId, "--emoji", EMOJI];
  if (participant) args.push("--participant", participant);
  if (fromMe) args.push("--from-me");
  if (dryRun) args.push("--dry-run");
  return args;
}

function runReact({ target, messageId, participant, fromMe }) {
  const args = buildReactArgs({ target, messageId, participant, fromMe }, { dryRun: !!process.env.ACK_REACT_DRY_RUN });
  return new Promise((resolve) => {
    execFile(LAUNCHER, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}

/** Hook entry point — never throws; a failed 👍 must not block message processing. */
export default async function ackReact(event) {
  try {
    const groupId = await resolveGroupId();
    if (!groupId) return; // group not configured yet
    const decision = decideReaction(event, groupId);
    if (!decision.react) return;
    await runReact(decision);
  } catch {
    // swallow — acknowledgment is best-effort and must never break the pipeline
  }
}

export { runReact, resolveGroupId };
