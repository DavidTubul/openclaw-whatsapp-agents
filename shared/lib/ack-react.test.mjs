// shared/lib/ack-react.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideReaction,
  decideAck,
  isAddressedToAgent,
  buildReactArgs,
  pickParticipant,
  runReact,
  DEFAULT_EMOJI,
  DEFAULT_LAUNCHER,
} from "./ack-react.mjs";

const GROUP = "120363000000000000@g.us";
const GROUP_B = "120363000000000002@g.us";

// A realistic inbound group message event (David sending in his own group).
function inbound(overrides = {}) {
  const ctx = {
    channelId: "whatsapp",
    conversationId: GROUP,
    from: GROUP, // NOTE: for groups, ctx.from is the GROUP jid, not the sender
    messageId: "MSG123",
    metadata: {
      to: "972500000000",          // bot's own (== David's) number
      senderId: "972500000000",    // David sent it → senderE164 == own → fromMe
      senderE164: "972500000000",
    },
    ...overrides.context,
  };
  return { type: "message", action: "received", ...overrides, context: ctx };
}

test("pickParticipant returns first non-empty trimmed string", () => {
  assert.equal(pickParticipant(undefined, "  ", "  abc "), "abc");
  assert.equal(pickParticipant(null, ""), undefined);
  assert.equal(pickParticipant(42, "x"), "x"); // non-strings skipped
});

test("decideReaction: reacts to a valid inbound group message (single id)", () => {
  const d = decideReaction(inbound(), GROUP);
  assert.equal(d.react, true);
  assert.equal(d.target, GROUP);
  assert.equal(d.messageId, "MSG123");
  assert.equal(d.participant, "972500000000");
  assert.equal(d.fromMe, true);
  assert.equal(d.reason, "ok");
});

test("decideReaction: target is the originating conversation, not the primary (array of ids)", () => {
  // message arrives in the SECONDARY group; must react there.
  const ev = inbound({ context: { conversationId: GROUP_B } });
  // rebuild ctx fully since the spread above only merged top-level
  ev.context = {
    channelId: "whatsapp",
    conversationId: GROUP_B,
    from: GROUP_B,
    messageId: "MSGB",
    metadata: { to: "972500000000", senderId: "972500000000", senderE164: "972500000000" },
  };
  const d = decideReaction(ev, [GROUP, GROUP_B]);
  assert.equal(d.react, true);
  assert.equal(d.target, GROUP_B);
  assert.equal(d.messageId, "MSGB");
});

test("decideReaction: array support — conversation not in the set is rejected", () => {
  const ev = inbound();
  ev.context.conversationId = "999@g.us";
  const d = decideReaction(ev, [GROUP, GROUP_B]);
  assert.equal(d.react, false);
  assert.equal(d.reason, "conversation=999@g.us");
});

test("decideReaction: fromMe false when sender != own number (a guest writes)", () => {
  const ev = inbound();
  ev.context.metadata = { to: "972500000000", senderId: "972511111111", senderE164: "972511111111" };
  const d = decideReaction(ev, GROUP);
  assert.equal(d.react, true);
  assert.equal(d.fromMe, false);
  assert.equal(d.participant, "972511111111");
});

test("decideReaction: participant prefers senderId, senderE164 used for fromMe match", () => {
  const ev = inbound();
  // senderId is a LID/jid; senderE164 is the phone — own match is on senderE164 first.
  ev.context.metadata = { to: "972500000000", senderId: "lid:abc", senderE164: "972500000000" };
  const d = decideReaction(ev, GROUP);
  assert.equal(d.participant, "lid:abc");      // pickParticipant(senderId, senderE164)
  assert.equal(d.fromMe, true);                // senderE164 == to
});

test("decideReaction: rejects non-message events", () => {
  assert.equal(decideReaction(null, GROUP).react, false);
  assert.equal(decideReaction({ type: "presence" }, GROUP).react, false);
  assert.equal(decideReaction({ type: "message", action: "sent", context: {} }, GROUP).reason, "action=sent");
});

test("decideReaction: rejects non-whatsapp channel", () => {
  const ev = inbound();
  ev.context.channelId = "telegram";
  assert.equal(decideReaction(ev, GROUP).reason, "channel=telegram");
});

test("decideReaction: rejects when groupId missing / null / empty array", () => {
  assert.equal(decideReaction(inbound(), null).react, false);
  assert.equal(decideReaction(inbound(), undefined).react, false);
  assert.equal(decideReaction(inbound(), []).react, false);
});

test("decideReaction: rejects when no messageId", () => {
  const ev = inbound();
  delete ev.context.messageId;
  assert.equal(decideReaction(ev, GROUP).reason, "no messageId");
});

test("decideReaction: missing metadata → no participant, fromMe false, still reacts", () => {
  const ev = inbound();
  delete ev.context.metadata;
  const d = decideReaction(ev, GROUP);
  assert.equal(d.react, true);
  assert.equal(d.participant, undefined);
  assert.equal(d.fromMe, false);
});

// ── addressed-to-agent (wake-word) + full ack decision (owner policy 2026-07-15) ────────────────

const WAKE = "דיגיט";
function inboundText(text, overrides = {}) {
  const ev = inbound(overrides);
  ev.context.content = text;
  return ev;
}

test("isAddressedToAgent: scope 'all' is always addressed (even with no wake-word / no text)", () => {
  assert.equal(isAddressedToAgent(inbound(), { wakeWord: WAKE, scope: "all" }), true);
  assert.equal(isAddressedToAgent(inboundText(""), { scope: "all" }), true);
});

test("isAddressedToAgent: scope 'mentions' matches the wake-word as a substring", () => {
  assert.equal(isAddressedToAgent(inboundText("היי דיגיט מה קורה"), { wakeWord: WAKE }), true);
  assert.equal(isAddressedToAgent(inboundText("דיגיט?"), { wakeWord: WAKE }), true);        // punctuation-tolerant
  assert.equal(isAddressedToAgent(inboundText("שלום לכולם"), { wakeWord: WAKE }), false);   // no wake-word
  assert.equal(isAddressedToAgent(inboundText(""), { wakeWord: WAKE }), false);             // empty text
});

test("isAddressedToAgent: default scope is 'mentions'", () => {
  assert.equal(isAddressedToAgent(inboundText("היי דיגיט"), { wakeWord: WAKE }), true);
  assert.equal(isAddressedToAgent(inboundText("סתם הודעה"), { wakeWord: WAKE }), false);
});

test("isAddressedToAgent: prefers an explicit mention flag when the context provides one", () => {
  const ev = inboundText("סתם הודעה בלי שם"); // no wake-word in text
  ev.context.wasMentioned = true;
  assert.equal(isAddressedToAgent(ev, { wakeWord: WAKE }), true);   // explicit true wins over text miss
  const ev2 = inboundText("היי דיגיט");
  ev2.context.wasMentioned = false;
  assert.equal(isAddressedToAgent(ev2, { wakeWord: WAKE }), false); // explicit false wins over text hit
});

test("isAddressedToAgent: metadata.wasMentioned=true with NO wake-word → addressed (quote-reply path)", () => {
  // Vendored patch #4 [inbound-hook-mention] delivers the flag on ctx.metadata (not ctx directly).
  // A quote-reply to the bot (e.g. member replying "נקי" to the daily reminder) has no wake word
  // but arrives with metadata.wasMentioned=true → must be treated as addressed so it gets a 👍.
  const ev = inboundText("נקי");
  ev.context.metadata = { ...ev.context.metadata, wasMentioned: true };
  assert.equal(isAddressedToAgent(ev, { wakeWord: WAKE }), true);
});

test("isAddressedToAgent: metadata.wasMentioned=false WINS over a wake-word hit (explicit flag precedence)", () => {
  // A boolean explicit flag takes precedence entirely — even a false flag overrides a text match.
  const ev = inboundText("היי דיגיט");
  ev.context.metadata = { ...ev.context.metadata, wasMentioned: false };
  assert.equal(isAddressedToAgent(ev, { wakeWord: WAKE }), false);
});

test("isAddressedToAgent: no wake-word + no flag → not addressed; never throws on junk", () => {
  assert.equal(isAddressedToAgent(inboundText("דיגיט"), {}), false); // no wakeWord configured
  assert.equal(isAddressedToAgent(undefined, { wakeWord: WAKE }), false);
  assert.equal(isAddressedToAgent(null, { wakeWord: WAKE }), false);
});

const agentDigit = { groupIds: [GROUP], persona: { name: WAKE }, ackReact: { enabled: true, scope: "mentions" } };

test("decideAck: mentions scope — reacts to a message addressed to the bot", () => {
  const d = decideAck(inboundText("היי דיגיט יש עדכון?"), agentDigit);
  assert.equal(d.react, true);
  assert.equal(d.target, GROUP);
  assert.equal(d.messageId, "MSG123");
});

test("decideAck: mentions scope — no react on group chatter that doesn't call the bot", () => {
  const d = decideAck(inboundText("מישהו ראה את המשחק אתמול?"), agentDigit);
  assert.equal(d.react, false);
  assert.equal(d.reason, "not addressed to agent");
});

test("decideAck: mentions scope — quote-reply (metadata.wasMentioned, no wake-word) is acked", () => {
  // The zorro bug: a member replies "נקי" to the bot's daily reminder. No wake word, but the
  // vendored emit tags it metadata.wasMentioned=true → decideAck must react.
  const ev = inboundText("נקי");
  ev.context.metadata = { ...ev.context.metadata, wasMentioned: true };
  const d = decideAck(ev, agentDigit);
  assert.equal(d.react, true);
  assert.equal(d.messageId, "MSG123");
});

test("decideAck: enabled:false opts the agent out entirely (even when addressed)", () => {
  const off = { ...agentDigit, ackReact: { enabled: false, scope: "mentions" } };
  const d = decideAck(inboundText("היי דיגיט"), off);
  assert.equal(d.react, false);
  assert.equal(d.reason, "ackReact disabled");
});

test("decideAck: scope 'all' reacts to every inbound in-group (no wake-word needed)", () => {
  const all = { ...agentDigit, ackReact: { enabled: true, scope: "all" } };
  const d = decideAck(inboundText("סתם צ'אט בלי שם"), all);
  assert.equal(d.react, true);
});

test("decideAck: absent ackReact block defaults to enabled + mentions", () => {
  const bare = { groupIds: [GROUP], persona: { name: WAKE } }; // no ackReact
  assert.equal(decideAck(inboundText("היי דיגיט"), bare).react, true);
  assert.equal(decideAck(inboundText("שלום"), bare).react, false);
});

test("decideAck: a message in a group the agent doesn't own → no react (group scoping)", () => {
  const ev = inboundText("היי דיגיט");
  ev.context.conversationId = "999@g.us";
  const d = decideAck(ev, agentDigit);
  assert.equal(d.react, false); // decideReaction rejects the foreign conversation
});

test("decideAck: null agent → no react, never throws", () => {
  assert.equal(decideAck(inboundText("היי דיגיט"), null).react, false);
});

test("buildReactArgs: full argv with participant + fromMe", () => {
  const args = buildReactArgs({ target: GROUP, messageId: "M1", participant: "972500000000", fromMe: true });
  assert.deepEqual(args, [
    "message", "react", "--channel", "whatsapp",
    "--target", GROUP, "--message-id", "M1", "--emoji", DEFAULT_EMOJI,
    "--participant", "972500000000", "--from-me",
  ]);
});

test("buildReactArgs: omits participant/from-me when absent", () => {
  const args = buildReactArgs({ target: GROUP, messageId: "M1", participant: undefined, fromMe: false });
  assert.deepEqual(args, [
    "message", "react", "--channel", "whatsapp",
    "--target", GROUP, "--message-id", "M1", "--emoji", DEFAULT_EMOJI,
  ]);
});

test("buildReactArgs: dryRun appends --dry-run; emoji override honoured", () => {
  const args = buildReactArgs(
    { target: GROUP, messageId: "M1", participant: "p", fromMe: true },
    { emoji: "🔥", dryRun: true },
  );
  assert.equal(args[args.length - 1], "--dry-run");
  assert.ok(args.includes("🔥"));
  assert.ok(!args.includes(DEFAULT_EMOJI));
});

test("runReact: end-to-end via a fake launcher in dry-run, resolves without throwing", async () => {
  // Use `node -e` echo as a stand-in launcher so we exercise the execFile path
  // without invoking the real gateway. It just prints the argv and exits 0.
  const prevDry = process.env.ACK_REACT_DRY_RUN;
  process.env.ACK_REACT_DRY_RUN = "1";
  try {
    const res = await runReact(
      { target: GROUP, messageId: "M1", participant: "972500000000", fromMe: true },
      { launcher: "/bin/echo" },
    );
    assert.equal(res.err, null);
    // /bin/echo prints the args; --dry-run must be present (env honoured).
    assert.match(res.stdout, /--dry-run/);
    assert.match(res.stdout, /--message-id M1/);
  } finally {
    if (prevDry === undefined) delete process.env.ACK_REACT_DRY_RUN;
    else process.env.ACK_REACT_DRY_RUN = prevDry;
  }
});

test("runReact: a missing launcher resolves with an error (never throws)", async () => {
  const res = await runReact(
    { target: GROUP, messageId: "M1" },
    { launcher: "/nonexistent/launcher-xyz" },
  );
  assert.ok(res.err, "expected an err object for a missing binary");
});

test("module exposes stable defaults", () => {
  assert.equal(DEFAULT_EMOJI, "👍");
  // Launcher is derived from the module location; assert shape, not a host path.
  assert.ok(DEFAULT_LAUNCHER.endsWith("/openclaw"));
  assert.ok(DEFAULT_LAUNCHER.startsWith("/"));
});
