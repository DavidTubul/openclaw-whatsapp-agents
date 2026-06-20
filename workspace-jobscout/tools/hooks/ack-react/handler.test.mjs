import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReaction, buildReactArgs } from "./handler.js";

const GROUP = "120363000000000000@g.us";

// Mirrors the real WhatsApp message:received shape: `from` is the GROUP jid, and the sender
// lives in metadata. This bot runs on David's own account, so account (`to`) == sender.
const baseEvent = (overrides = {}) => {
  const { context: ctxOverride, metadata: metaOverride, ...rest } = overrides;
  return {
    type: "message",
    action: "received",
    ...rest,
    context: {
      channelId: "whatsapp",
      conversationId: GROUP,
      messageId: "3EB0ABC123",
      from: GROUP,
      ...ctxOverride,
      metadata: {
        to: "+972500000000",
        senderId: "+972500000000",
        senderE164: "+972500000000",
        senderName: "David Tubul",
        ...metaOverride,
      },
    },
  };
};

test("own-account message: participant from metadata.senderId, fromMe=true", () => {
  const d = decideReaction(baseEvent(), GROUP);
  assert.equal(d.react, true);
  assert.equal(d.target, GROUP);
  assert.equal(d.messageId, "3EB0ABC123");
  assert.equal(d.participant, "+972500000000"); // from metadata, NOT the group jid
  assert.equal(d.fromMe, true);                 // sender == account → own message
});

test("never uses the group jid (ctx.from) as participant", () => {
  const d = decideReaction(baseEvent(), GROUP);
  assert.notEqual(d.participant, GROUP);
});

test("different sender (not the account) → fromMe=false", () => {
  const d = decideReaction(baseEvent({ metadata: { senderId: "972500000001@s.whatsapp.net", senderE164: "+972500000001" } }), GROUP);
  assert.equal(d.react, true);
  assert.equal(d.participant, "972500000001@s.whatsapp.net");
  assert.equal(d.fromMe, false);
});

test("no sender fields → participant undefined, fromMe false (still reacts)", () => {
  const d = decideReaction(baseEvent({ metadata: { to: undefined, senderId: undefined, senderE164: undefined } }), GROUP);
  assert.equal(d.react, true);
  assert.equal(d.participant, undefined);
  assert.equal(d.fromMe, false);
});

test("ignores non-received message actions", () => {
  const d = decideReaction(baseEvent({ action: "sent" }), GROUP);
  assert.equal(d.react, false);
});

test("ignores non-whatsapp channels", () => {
  const d = decideReaction(baseEvent({ context: { channelId: "telegram" } }), GROUP);
  assert.equal(d.react, false);
});

test("ignores a different conversation (rule #1: only the configured group)", () => {
  const d = decideReaction(baseEvent({ context: { conversationId: "972500000000@s.whatsapp.net" } }), GROUP);
  assert.equal(d.react, false);
});

test("ignores when messageId is missing", () => {
  const d = decideReaction(baseEvent({ context: { messageId: undefined } }), GROUP);
  assert.equal(d.react, false);
});

test("ignores non-message event types", () => {
  const d = decideReaction({ type: "command", action: "received", context: {} }, GROUP);
  assert.equal(d.react, false);
});

test("buildReactArgs passes channel, target, message-id and 👍 emoji in order", () => {
  const args = buildReactArgs({ target: GROUP, messageId: "3EB0XYZ" });
  assert.deepEqual(args, [
    "message", "react", "--channel", "whatsapp",
    "--target", GROUP, "--message-id", "3EB0XYZ", "--emoji", "👍",
  ]);
});

test("buildReactArgs includes --participant when given (required for group rendering)", () => {
  const args = buildReactArgs({ target: GROUP, messageId: "3EB0XYZ", participant: "+972500000000" });
  const i = args.indexOf("--participant");
  assert.ok(i > -1, "--participant present");
  assert.equal(args[i + 1], "+972500000000");
});

test("buildReactArgs omits --participant when absent", () => {
  assert.ok(!buildReactArgs({ target: GROUP, messageId: "x" }).includes("--participant"));
});

test("buildReactArgs adds --from-me only when fromMe is true", () => {
  assert.ok(buildReactArgs({ target: GROUP, messageId: "x", fromMe: true }).includes("--from-me"));
  assert.ok(!buildReactArgs({ target: GROUP, messageId: "x", fromMe: false }).includes("--from-me"));
});

test("buildReactArgs appends --dry-run only when requested", () => {
  assert.ok(!buildReactArgs({ target: GROUP, messageId: "x" }).includes("--dry-run"));
  assert.ok(buildReactArgs({ target: GROUP, messageId: "x" }, { dryRun: true }).includes("--dry-run"));
});

import { runReact } from "./handler.js";

test("runReact invokes the launcher in dry-run without throwing", async () => {
  process.env.ACK_REACT_DRY_RUN = "1";
  const { err, stdout, stderr } = await runReact({ target: GROUP, messageId: "3EB0DRYRUN" });
  // dry-run must not error; CLI prints "[dry-run] would run react via whatsapp"
  // (the message-id is not echoed in dry-run output, but "dry-run" is always present)
  assert.equal(err, null, `react CLI errored: ${stderr}`);
  assert.match(`${stdout}${stderr}`, /dry-run/);
});
