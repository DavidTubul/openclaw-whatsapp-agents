import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLog, truncate, formatRecentMd, classify } from "./handler.js";

const GROUP = "120363000000000000@g.us";
const ev = (action, over = {}) => ({
  type: "message", action,
  context: { channelId: "whatsapp", conversationId: GROUP, messageId: "M1",
    content: "שלום דיגיט", timestamp: "2026-05-30T10:00:00.000Z",
    metadata: { senderName: "David Tubul" }, ...over },
});

test("inbound in group → log as david with content", () => {
  const d = decideLog(ev("received"), GROUP);
  assert.deepEqual({ log: d.log, from: d.from, text: d.text }, { log: true, from: "david", text: "שלום דיגיט" });
});
test("outbound in group → log as דיגיט", () => {
  const d = decideLog(ev("sent", { content: "מצאתי 3 עסקאות" }), GROUP);
  assert.equal(d.log, true); assert.equal(d.from, "דיגיט"); assert.equal(d.text, "מצאתי 3 עסקאות");
});
test("other conversation → not logged (only the configured group)", () => {
  assert.equal(decideLog(ev("received", { conversationId: "x@g.us" }), GROUP).log, false);
});
test("non-whatsapp channel → not logged", () => {
  assert.equal(decideLog(ev("received", { channelId: "telegram" }), GROUP).log, false);
});
test("empty/missing content → not logged", () => {
  assert.equal(decideLog(ev("received", { content: "" }), GROUP).log, false);
  assert.equal(decideLog(ev("received", { content: undefined }), GROUP).log, false);
});
test("non-message event → not logged", () => {
  assert.equal(decideLog({ type: "command", action: "received", context: {} }, GROUP).log, false);
});
test("truncate caps long text with ellipsis, keeps short text", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("a".repeat(20), 10), "aaaaaaaaaa…");
});
test("formatRecentMd renders last N, truncates דיגיט replies, newest last", () => {
  const recs = [
    { ts: "2026-05-30T09:00:00Z", from: "david", text: "היי" },
    { ts: "2026-05-30T09:01:00Z", from: "דיגיט", text: "y".repeat(800) },
    { ts: "2026-05-30T09:02:00Z", from: "david", text: "תודה" },
  ];
  const md = formatRecentMd(recs, 2, 300);
  assert.ok(md.includes("תודה"));
  assert.ok(!md.includes("היי"));
  assert.ok(md.includes("…"));
  assert.ok(md.indexOf("David") < md.indexOf("תודה"));
});
test("classify buckets resets and chat", () => {
  assert.equal(classify({ from: "דיגיט", text: "התחלתי שיחה חדשה כדי להישאר חד 🙂" }), "reset");
  assert.equal(classify({ from: "david", text: "היי דיגיט מה קורה" }), "chat");
  assert.equal(classify({ from: "דיגיט", text: "בוקר אור David! ☀️ מה שלומך?" }), "chat"); // a real conversational reply
});

test("formatRecentMd collapses reset/background runs to one marker and keeps N chat turns", () => {
  const recs = [
    { ts: "2026-06-01T18:00:00Z", from: "david", text: "ערב טוב" },
    { ts: "2026-06-01T18:01:00Z", from: "דיגיט", text: "ערב טוב David!" },
    // background noise — should collapse to ONE marker
    { ts: "2026-06-02T04:31:00Z", from: "דיגיט", text: "התחלתי שיחה חדשה כדי להישאר חד" },
    { ts: "2026-06-02T04:32:00Z", from: "דיגיט", text: "התחלתי שיחה חדשה שוב" },
    { ts: "2026-06-02T09:00:00Z", from: "david", text: "מה היה אתמול" },
  ];
  const md = formatRecentMd(recs, 60, 300);
  // both real chat turns survive across the noise
  assert.ok(md.includes("ערב טוב"));
  assert.ok(md.includes("מה היה אתמול"));
  // the noise is collapsed to a single dated marker
  assert.ok(md.includes("אירוע רקע"));
  assert.equal((md.match(/— \[/g) || []).length, 1); // exactly one marker for the run
  assert.ok(md.includes("שיחות אחרונות (3)")); // 3 chat turns counted
});

test("formatRecentMd keeps only the last N chat turns, markers ride free", () => {
  const recs = [
    { ts: "2026-06-01T10:00:00Z", from: "david", text: "turn-A" },
    { ts: "2026-06-01T10:01:00Z", from: "דיגיט", text: "התחלתי שיחה חדשה — noise" },
    { ts: "2026-06-01T11:00:00Z", from: "david", text: "turn-B" },
    { ts: "2026-06-01T12:00:00Z", from: "david", text: "turn-C" },
  ];
  const md = formatRecentMd(recs, 2, 300);
  assert.ok(!md.includes("turn-A")); // evicted (only last 2 chat turns kept)
  assert.ok(md.includes("turn-B"));
  assert.ok(md.includes("turn-C"));
});

test('decideLog captures senderE164 and fromMe=false for a received group msg from another number', () => {
  const ev = { type: 'message', action: 'received', context: {
    channelId: 'whatsapp', conversationId: 'G@g.us', content: 'שלום',
    timestamp: '2026-05-30T20:00:00.000Z',
    metadata: { senderE164: '972500000001', senderId: '972500000001@s.whatsapp.net', to: '972500000000' } } };
  const d = decideLog(ev, 'G@g.us');
  assert.equal(d.log, true);
  assert.equal(d.e164, '972500000001');
  assert.equal(d.fromMe, false);
});
test('decideLog includes inbound messageId for quoted replies', () => {
  const d = decideLog(ev("received"), GROUP);
  assert.equal(d.messageId, "M1");
});
test('decideLog messageId is null when the inbound event has none', () => {
  const d = decideLog(ev("received", { messageId: undefined }), GROUP);
  assert.equal(d.messageId, null);
});
test('decideLog leaves messageId undefined for outbound (דיגיט) messages', () => {
  const d = decideLog(ev("sent", { content: "מצאתי 3 עסקאות" }), GROUP);
  assert.equal(d.messageId, undefined);
});
test('decideLog marks fromMe when sender == own number (owner self-chat)', () => {
  const ev = { type: 'message', action: 'received', context: {
    channelId: 'whatsapp', conversationId: 'G@g.us', content: 'hi',
    metadata: { senderE164: '972500000000', to: '972500000000' } } };
  const d = decideLog(ev, 'G@g.us');
  assert.equal(d.fromMe, true);
});
