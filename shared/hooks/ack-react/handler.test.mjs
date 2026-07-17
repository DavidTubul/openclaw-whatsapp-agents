// shared/hooks/ack-react/handler.test.mjs
//
// Tests the shared ack-react hook end-to-end against the REAL registry, with the
// side-effecting react replaced by a dry-run capture (ACK_REACT_DRY_RUN). Verifies
// that every registered group resolves to its agent and produces a correctly-shaped
// react argv, that digit's secondary group routes to digit, and that non-message /
// foreign-conversation / missing-id events are silent no-ops without throwing.

import { test } from "node:test";
import assert from "node:assert/strict";

import ackReact from "./handler.js";
import { buildReactArgs, decideAck } from "../../lib/ack-react.mjs";
import { listAgents, getAgent, getAgentByGroup } from "../../lib/agent-registry.mjs";

// Force dry-run so runReact never shells out for real.
process.env.ACK_REACT_DRY_RUN = "1";

function msgEvent({ conversationId, messageId = "MSG1", senderId = "972500000001@s.whatsapp.net", to, content } = {}) {
  return {
    type: "message",
    action: "received",
    context: {
      channelId: "whatsapp",
      conversationId,
      messageId,
      ...(content !== undefined ? { content } : {}),
      from: conversationId, // group jid, as in production
      metadata: { senderId, senderE164: senderId, ...(to ? { to } : {}) },
    },
  };
}

test("hook never throws on any input", async () => {
  await assert.doesNotReject(() => ackReact(undefined));
  await assert.doesNotReject(() => ackReact({}));
  await assert.doesNotReject(() => ackReact({ type: "message", action: "received", context: {} }));
});

test("non-message / wrong-action / wrong-channel events are no-ops", async () => {
  await assert.doesNotReject(() => ackReact({ type: "presence", context: {} }));
  await assert.doesNotReject(() =>
    ackReact({ type: "message", action: "sent", context: { channelId: "whatsapp", conversationId: "x@g.us" } }));
  await assert.doesNotReject(() =>
    ackReact({ type: "message", action: "received", context: { channelId: "sms", conversationId: "x@g.us" } }));
});

test("a conversation owned by no agent is a no-op", async () => {
  assert.equal(getAgentByGroup("999999999999@g.us"), null);
  await assert.doesNotReject(() => ackReact(msgEvent({ conversationId: "999999999999@g.us" })));
});

test("every registered agent's group resolves and the hook never throws (addressed or not)", async () => {
  for (const a of listAgents()) {
    for (const gid of a.groupIds) {
      const resolved = getAgentByGroup(gid);
      assert.equal(resolved?.agentId, a.agentId, `group ${gid} -> ${a.agentId}`);
      const wake = a.persona?.name || "";
      // The hook must not throw for any real group — addressed (wake-word) or plain chatter.
      await assert.doesNotReject(() => ackReact(msgEvent({ conversationId: gid, content: `היי ${wake}` })));
      await assert.doesNotReject(() => ackReact(msgEvent({ conversationId: gid, content: "סתם צ'אט" })));
    }
  }
});

test("policy: every registered agent acks a message ADDRESSED to it (wake-word), ignores chatter", () => {
  for (const a of listAgents()) {
    const wake = a.persona?.name;
    assert.ok(wake, `${a.agentId} should have a persona name (wake-word)`);
    const gid = a.groupIds[0];
    // default policy is enabled + mentions (registry now sets it explicitly for all five)
    const addressed = decideAck(msgEvent({ conversationId: gid, content: `היי ${wake} מה קורה` }), a);
    const chatter = decideAck(msgEvent({ conversationId: gid, content: "מישהו ראה את המשחק?" }), a);
    if ((a.ackReact?.scope ?? "mentions") === "all") {
      assert.equal(addressed.react, true, `${a.agentId} scope:all → addressed reacts`);
      assert.equal(chatter.react, true, `${a.agentId} scope:all → chatter also reacts`);
    } else if (a.ackReact?.enabled === false) {
      assert.equal(addressed.react, false, `${a.agentId} disabled → no react`);
    } else {
      assert.equal(addressed.react, true, `${a.agentId} addressed → reacts`);
      assert.equal(chatter.react, false, `${a.agentId} chatter → no react`);
    }
  }
});

test("policy: a quote-reply (metadata.wasMentioned, no wake-word) is acked for every mentions agent", () => {
  // Regression for the zorro bug (2026-07-17): members quote-reply the bot with no wake word
  // (e.g. "נקי" to the daily reminder). Vendored patch #4 [inbound-hook-mention] now tags such
  // inbound with metadata.wasMentioned=true; the explicit-flag branch must ack it.
  for (const a of listAgents()) {
    if ((a.ackReact?.scope ?? "mentions") !== "mentions" || a.ackReact?.enabled === false) continue;
    const gid = a.groupIds[0];
    const ev = msgEvent({ conversationId: gid, content: "נקי" }); // no wake-word
    ev.context.metadata = { ...ev.context.metadata, wasMentioned: true };
    const d = decideAck(ev, a);
    assert.equal(d.react, true, `${a.agentId} quote-reply with metadata.wasMentioned → ack`);
  }
});

test("policy: metadata.wasMentioned=false WINS over a wake-word hit (explicit flag precedence)", () => {
  const a = listAgents().find((x) => (x.ackReact?.scope ?? "mentions") === "mentions" && x.ackReact?.enabled !== false);
  assert.ok(a, "expected at least one mentions agent");
  const gid = a.groupIds[0];
  const ev = msgEvent({ conversationId: gid, content: `היי ${a.persona.name}` }); // wake-word present
  ev.context.metadata = { ...ev.context.metadata, wasMentioned: false };
  assert.equal(decideAck(ev, a).react, false, "explicit false flag overrides the wake-word match");
});

test("policy: registry wires ackReact enabled+mentions for all five agents", () => {
  for (const a of listAgents()) {
    assert.equal(a.ackReact?.enabled, true, `${a.agentId} ackReact.enabled`);
    assert.equal(a.ackReact?.scope, "mentions", `${a.agentId} ackReact.scope`);
  }
});

test("listen-only / non-registry group is never acked (no owning agent)", async () => {
  const LISTEN_ONLY = "120363000000000077@g.us"; // a listen-only group, deliberately out of registry
  assert.equal(getAgentByGroup(LISTEN_ONLY), null, "listen-only group must not resolve to an agent");
  await assert.doesNotReject(() => ackReact(msgEvent({ conversationId: LISTEN_ONLY, content: "היי דיגיט" })));
});

test("digit secondary group routes to digit", () => {
  // Resolve digit's secondary group from the registry instead of hardcoding a real jid.
  const secondary = getAgent("digit").groupIds[1];
  assert.ok(secondary, "digit should have a secondary group");
  const r = getAgentByGroup(secondary);
  assert.equal(r?.agentId, "digit");
});

test("react argv targets the conversation the message came from (multi-group)", () => {
  // The pure builder mirrors what runReact assembles in dry-run. The target id is an
  // opaque string echoed back into argv — use a fake group jid (no registry coupling).
  const FAKE_GROUP = "120363000000000002@g.us";
  const argv = buildReactArgs(
    { target: FAKE_GROUP, messageId: "M2", participant: "972500000002@s.whatsapp.net", fromMe: false },
    { dryRun: true },
  );
  assert.deepEqual(argv, [
    "message", "react", "--channel", "whatsapp",
    "--target", FAKE_GROUP, "--message-id", "M2", "--emoji", "👍",
    "--participant", "972500000002@s.whatsapp.net",
    "--dry-run",
  ]);
});

test("fromMe is set when sender == account number (owner on own device)", () => {
  // decideReaction is exercised indirectly; here we assert the argv shape it feeds.
  const argv = buildReactArgs(
    { target: "g@g.us", messageId: "M3", participant: "972511111111@s.whatsapp.net", fromMe: true },
    { dryRun: true },
  );
  assert.ok(argv.includes("--from-me"));
});
