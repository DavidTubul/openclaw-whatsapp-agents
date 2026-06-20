import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMedia, decideLog, formatRecentMd, chatSheetRow } from "./handler.js";

const GROUP = "120363000000000000@g.us";
const base = (over = {}) => ({
  type: "message", action: "received",
  context: { channelId: "whatsapp", conversationId: GROUP, messageId: "M1",
    metadata: { senderE164: "972500000000", to: "972500000000" }, timestamp: "2026-06-13T10:00:00Z", ...over },
});

test("extractMedia probes attachments/media shapes", () => {
  assert.deepEqual(extractMedia({ attachments: ["/p/a.jpg"] }), [{ path: "/p/a.jpg" }]);
  assert.deepEqual(
    extractMedia({ media: [{ localPath: "/x/b.jpg", mimetype: "image/jpeg", filename: "b.jpg" }] }),
    [{ path: "/x/b.jpg", type: "image/jpeg", name: "b.jpg" }],
  );
  assert.deepEqual(extractMedia({ metadata: { media: { url: "/u/c.png" } } }), [{ path: "/u/c.png", type: undefined, name: undefined }]);
  assert.deepEqual(extractMedia({}), []);
});

test("decideLog: text message in group → logged as customer", () => {
  const d = decideLog(base({ content: "הפיצוחים לא טריים" }), GROUP);
  assert.equal(d.log, true);
  assert.equal(d.from, "customer");
  assert.equal(d.text, "הפיצוחים לא טריים");
});

test("decideLog: media-only message (no caption) is still logged", () => {
  const d = decideLog(base({ content: "", attachments: [{ path: "/m/x.jpg", type: "image/jpeg" }] }), GROUP);
  assert.equal(d.log, true);
  assert.equal(d.media.length, 1);
  assert.match(d.text, /מדיה/);
});

test("decideLog: empty + no media → skipped", () => {
  assert.equal(decideLog(base({ content: "" }), GROUP).log, false);
});

test("decideLog: other group → skipped", () => {
  assert.equal(decideLog(base({ content: "hi", conversationId: "other@g.us" }), GROUP).log, false);
});

test("chatSheetRow — inbound carries customer name+phone, correct direction", () => {
  const row = chatSheetRow({ ts: "2026-06-13T10:00:00Z", from: "customer", conversation: "g@g.us", name: "דנה", e164: "972501234567", text: "לא טרי" });
  assert.deepEqual(row, { ts: "2026-06-13T10:00:00Z", conversation: "g@g.us", direction: "לקוח→פיצי", name: "דנה", phone: "972501234567", text: "לא טרי" });
});

test("chatSheetRow — outbound is פיצי, no customer phone", () => {
  const row = chatSheetRow({ ts: "2026-06-13T10:01:00Z", from: "פיצי", conversation: "g@g.us", text: "פיצי לשירותך 🥜" });
  assert.equal(row.direction, "פיצי→לקוח");
  assert.equal(row.name, "פיצי");
  assert.equal(row.phone, "");
});

test("formatRecentMd labels customer vs פיצי", () => {
  const md = formatRecentMd([
    { ts: "2026-06-13T10:00:00Z", from: "customer", text: "שלום" },
    { ts: "2026-06-13T10:01:00Z", from: "פיצי", text: "פיצי לשירותך 🥜" },
  ], 10);
  assert.match(md, /\*\*לקוח\*\*/);
  assert.match(md, /\*\*פיצי\*\*/);
});
