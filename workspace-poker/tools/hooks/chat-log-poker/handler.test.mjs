import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLog, truncate, classify, formatRecentMd } from "./handler.js";
import { decideReaction, buildReactArgs } from "../ack-react-poker/handler.js";

const GROUP = "120363000000000000@g.us";

function inbound(text, { e164 = "972500000001", to = "972500000000", id = "MID1" } = {}) {
  return { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: text, messageId: id,
    timestamp: "2026-06-13T20:00:00.000Z", metadata: { senderE164: e164, to },
  } };
}

test("decideLog: logs inbound poker-group text, captures e164", () => {
  const d = decideLog(inbound("דילר תרשום שדני קנה 50"), GROUP);
  assert.equal(d.log, true);
  assert.equal(d.inbound, true);
  assert.equal(d.e164, "972500000001");
  assert.equal(d.fromMe, false);
});

test("decideLog: David's own message is fromMe", () => {
  const d = decideLog(inbound("היי", { e164: "972500000000" }), GROUP);
  assert.equal(d.fromMe, true);
});

test("decideLog: ignores other conversations + empty text", () => {
  assert.equal(decideLog(inbound("hi"), "other@g.us").log, false);
  assert.equal(decideLog(inbound("   "), GROUP).log, false);
});

test("formatRecentMd: bot reply truncated, players shown by speaker", () => {
  const recs = [
    { ts: "2026-06-13T20:00:00Z", from: "player", speaker: "דני", text: "דילר כמה אני בפלוס?" },
    { ts: "2026-06-13T20:00:05Z", from: "דילר", speaker: "דילר", text: "x".repeat(900) },
  ];
  const md = formatRecentMd(recs, 10, 100);
  assert.match(md, /\*\*דני\*\*/);
  assert.match(md, /\*\*דילר\*\*/);
  assert.ok(md.includes("…"));
});

test("classify + truncate", () => {
  assert.equal(classify({ text: "התחלתי שיחה חדשה" }), "reset");
  assert.equal(classify({ text: "שלום" }), "chat");
  assert.equal(truncate("abcdef", 3), "abc…");
});

test("decideReaction: reacts to inbound group msg with id", () => {
  const r = decideReaction(inbound("hi"), GROUP);
  assert.equal(r.react, true);
  assert.equal(r.target, GROUP);
  assert.equal(r.messageId, "MID1");
});

test("decideReaction: skips when no group / wrong conversation", () => {
  assert.equal(decideReaction(inbound("hi"), "").react, false);
  assert.equal(decideReaction(inbound("hi"), "other@g.us").react, false);
});

test("buildReactArgs: builds the react argv", () => {
  const args = buildReactArgs({ target: GROUP, messageId: "MID1", participant: "972500000001", fromMe: true });
  assert.ok(args.includes("react"));
  assert.ok(args.includes("--emoji"));
  assert.ok(args.includes("--from-me"));
});
