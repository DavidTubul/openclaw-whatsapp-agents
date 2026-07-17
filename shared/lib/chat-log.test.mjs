// shared/lib/chat-log.test.mjs — merged unit suite for the unified chat-log logic.
// Ports the existing per-bot handler.test.mjs cases (poker, zorro, digit) onto the parameterized
// API, plus jobscout-specific cases (scout collapse + people-roster default) and pitzi (media).
//
// Run: node --test shared/lib/chat-log.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideLog, truncate, classify, formatRecentMd, extractMedia,
  recordFileFor, resolveSpeaker, writeLog, tailHasMessageId,
  mediaKind, mediaPlaceholderText, displayTextFor, MEDIA_PLACEHOLDER_RE,
} from "./chat-log.mjs";

const GROUP = "120363000000000000@g.us";

// ── per-bot agentCfg fixtures (mirror the live workspaces' label/roster/group params) ────────────

function cfgBase(over = {}) {
  return {
    agentId: "test", botName: "BOT",
    labels: { inboundFrom: "user", outboundFrom: "BOT", inboundSpeakerDefault: "אורח", botSpeaker: "BOT" },
    groupId: GROUP, e164DigitsOnly: false, roster: { type: "none" }, classifyScout: false, media: false,
    paths: { configPath: "/nonexistent.json", dataDir: "/tmp", recentMd: "/tmp/r.md", lastInbound: "/tmp/li.json" },
    ...over,
  };
}

const cfgJobscout = cfgBase({
  agentId: "main", botName: "Scotty",
  labels: { inboundFrom: "david", outboundFrom: "scotty", inboundSpeakerDefault: "אורח", botSpeaker: "Scotty" },
  e164DigitsOnly: false, classifyScout: true, roster: { type: "people" },
});
const cfgDigit = cfgBase({
  agentId: "digit", botName: "דיגיט",
  labels: { inboundFrom: "david", outboundFrom: "דיגיט", inboundSpeakerDefault: "David", botSpeaker: "דיגיט" },
  e164DigitsOnly: false, roster: { type: "none" },
});
const cfgPoker = cfgBase({
  agentId: "poker", botName: "דילר",
  labels: { inboundFrom: "player", outboundFrom: "דילר", inboundSpeakerDefault: "שחקן", botSpeaker: "דילר" },
  e164DigitsOnly: true, roster: { type: "players", playersPath: "/np.json" },
});
const cfgZorro = cfgBase({
  agentId: "zorro", botName: "זורו",
  labels: { inboundFrom: "member", outboundFrom: "זורו", inboundSpeakerDefault: "חבר", botSpeaker: "זורו" },
  e164DigitsOnly: true, roster: { type: "members", membersPath: "/nm.jsonl" },
});
const cfgPitzi = cfgBase({
  agentId: "pitzi", botName: "פיצי",
  labels: { inboundFrom: "customer", outboundFrom: "פיצי", inboundSpeakerDefault: "לקוח", botSpeaker: "פיצי" },
  e164DigitsOnly: false, roster: { type: "none" }, media: true,
});

function inbound(text, { e164 = "972500000001", to = "972500000000", id = "MID1", conv = GROUP } = {}) {
  return { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: conv, content: text, messageId: id,
    timestamp: "2026-06-13T20:00:00.000Z", metadata: { senderE164: e164, to },
  } };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// POKER cases (ported from workspace-poker/.../handler.test.mjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("poker decideLog: logs inbound group text, captures e164", () => {
  const d = decideLog(inbound("דילר תרשום שדני קנה 50"), cfgPoker);
  assert.equal(d.log, true);
  assert.equal(d.inbound, true);
  assert.equal(d.e164, "972500000001");
  assert.equal(d.fromMe, false);
});

test("poker decideLog: David's own message is fromMe", () => {
  const d = decideLog(inbound("היי", { e164: "972500000000" }), cfgPoker);
  assert.equal(d.fromMe, true);
});

test("poker decideLog: ignores other conversations + empty text", () => {
  assert.equal(decideLog(inbound("hi", { conv: "other@g.us" }), cfgPoker).log, false);
  assert.equal(decideLog(inbound("   "), cfgPoker).log, false);
});

test("poker formatRecentMd: bot reply truncated, players shown by speaker", () => {
  const recs = [
    { ts: "2026-06-13T20:00:00Z", from: "player", speaker: "דני", text: "דילר כמה אני בפלוס?" },
    { ts: "2026-06-13T20:00:05Z", from: "דילר", speaker: "דילר", text: "x".repeat(900) },
  ];
  const md = formatRecentMd(recs, 10, 100, cfgPoker);
  assert.match(md, /\*\*דני\*\*/);
  assert.match(md, /\*\*דילר\*\*/);
  assert.ok(md.includes("…"));
});

test("poker classify + truncate", () => {
  assert.equal(classify({ text: "התחלתי שיחה חדשה" }, cfgPoker), "reset");
  assert.equal(classify({ text: "שלום" }, cfgPoker), "chat");
  assert.equal(truncate("abcdef", 3), "abc…");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ZORRO cases (ported from workspace-quitsmoke/.../handler.test.mjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("zorro decideLog: logs inbound group text, captures e164", () => {
  const d = decideLog(inbound("זורו היום יום נקי 5"), cfgZorro);
  assert.equal(d.log, true);
  assert.equal(d.inbound, true);
  assert.equal(d.e164, "972500000001");
  assert.equal(d.fromMe, false);
});

test("zorro decideLog: David's own message is fromMe", () => {
  const d = decideLog(inbound("היי", { e164: "972500000000" }), cfgZorro);
  assert.equal(d.fromMe, true);
});

test("zorro formatRecentMd: bot reply truncated, members shown by speaker", () => {
  const recs = [
    { ts: "2026-06-26T20:00:00Z", from: "member", speaker: "דני", text: "זורו כמה ימים נקיים יש לי?" },
    { ts: "2026-06-26T20:00:05Z", from: "זורו", speaker: "זורו", text: "x".repeat(900) },
  ];
  const md = formatRecentMd(recs, 10, 100, cfgZorro);
  assert.match(md, /\*\*דני\*\*/);
  assert.match(md, /\*\*זורו\*\*/);
  assert.ok(md.includes("…"));
});

test("zorro formatRecentMd: inbound with no resolved name falls back to default speaker", () => {
  const recs = [{ ts: "2026-06-26T20:00:00Z", from: "member", speaker: "חבר", text: "היי" }];
  const md = formatRecentMd(recs, 10, 600, cfgZorro);
  assert.match(md, /\*\*חבר\*\*/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DIGIT cases (ported from workspace-realestate/.../handler.test.mjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const digitEv = (action, over = {}) => ({
  type: "message", action,
  context: { channelId: "whatsapp", conversationId: GROUP, messageId: "M1",
    content: "שלום דיגיט", timestamp: "2026-05-30T10:00:00.000Z",
    metadata: { senderName: "David Tubul" }, ...over },
});

test("digit: inbound in group → log as david with content", () => {
  const d = decideLog(digitEv("received"), cfgDigit);
  assert.deepEqual({ log: d.log, from: d.from, text: d.text }, { log: true, from: "david", text: "שלום דיגיט" });
});
test("digit: outbound in group → log as דיגיט", () => {
  const d = decideLog(digitEv("sent", { content: "מצאתי 3 עסקאות" }), cfgDigit);
  assert.equal(d.log, true); assert.equal(d.from, "דיגיט"); assert.equal(d.text, "מצאתי 3 עסקאות");
});
test("digit: other conversation → not logged", () => {
  assert.equal(decideLog(digitEv("received", { conversationId: "x@g.us" }), cfgDigit).log, false);
});
test("digit multi-group: logs from any configured group, keyed by the originating group", () => {
  const GROUP_B = "120363000000000002@g.us";
  const cfgMulti = cfgBase({ ...cfgDigit, groupId: undefined, groupIds: [GROUP, GROUP_B] });
  const d = decideLog(digitEv("received", { conversationId: GROUP_B }), cfgMulti);
  assert.equal(d.log, true);
  assert.equal(d.groupId, GROUP_B);
});
test("digit multi-group: a group not in the list is not logged", () => {
  const cfgMulti = cfgBase({ ...cfgDigit, groupId: undefined, groupIds: [GROUP, "120363000000000002@g.us"] });
  assert.equal(decideLog(digitEv("received", { conversationId: "999@g.us" }), cfgMulti).log, false);
});
test("digit: non-whatsapp channel → not logged", () => {
  assert.equal(decideLog(digitEv("received", { channelId: "telegram" }), cfgDigit).log, false);
});
test("digit: empty/missing content → not logged", () => {
  assert.equal(decideLog(digitEv("received", { content: "" }), cfgDigit).log, false);
  assert.equal(decideLog(digitEv("received", { content: undefined }), cfgDigit).log, false);
});
test("digit: non-message event → not logged", () => {
  assert.equal(decideLog({ type: "command", action: "received", context: {} }, cfgDigit).log, false);
});
test("truncate caps long text with ellipsis, keeps short text", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("a".repeat(20), 10), "aaaaaaaaaa…");
});
test("digit formatRecentMd renders last N, truncates דיגיט replies, newest last", () => {
  const recs = [
    { ts: "2026-05-30T09:00:00Z", from: "david", text: "היי" },
    { ts: "2026-05-30T09:01:00Z", from: "דיגיט", text: "y".repeat(800) },
    { ts: "2026-05-30T09:02:00Z", from: "david", text: "תודה" },
  ];
  const md = formatRecentMd(recs, 2, 300, cfgDigit);
  assert.ok(md.includes("תודה"));
  assert.ok(!md.includes("היי"));
  assert.ok(md.includes("…"));
  assert.ok(md.indexOf("David") < md.indexOf("תודה"));
});
test("digit classify buckets resets and chat", () => {
  assert.equal(classify({ from: "דיגיט", text: "התחלתי שיחה חדשה כדי להישאר חד 🙂" }, cfgDigit), "reset");
  assert.equal(classify({ from: "david", text: "היי דיגיט מה קורה" }, cfgDigit), "chat");
  assert.equal(classify({ from: "דיגיט", text: "בוקר אור David! ☀️ מה שלומך?" }, cfgDigit), "chat");
});
test("digit formatRecentMd collapses reset/background runs to one marker and keeps N chat turns", () => {
  const recs = [
    { ts: "2026-06-01T18:00:00Z", from: "david", text: "ערב טוב" },
    { ts: "2026-06-01T18:01:00Z", from: "דיגיט", text: "ערב טוב David!" },
    { ts: "2026-06-02T04:31:00Z", from: "דיגיט", text: "התחלתי שיחה חדשה כדי להישאר חד" },
    { ts: "2026-06-02T04:32:00Z", from: "דיגיט", text: "התחלתי שיחה חדשה שוב" },
    { ts: "2026-06-02T09:00:00Z", from: "david", text: "מה היה אתמול" },
  ];
  const md = formatRecentMd(recs, 60, 300, cfgDigit);
  assert.ok(md.includes("ערב טוב"));
  assert.ok(md.includes("מה היה אתמול"));
  assert.ok(md.includes("אירוע רקע"));
  assert.equal((md.match(/— \[/g) || []).length, 1);
  assert.ok(md.includes("שיחות אחרונות (3)"));
});
test("digit formatRecentMd keeps only the last N chat turns, markers ride free", () => {
  const recs = [
    { ts: "2026-06-01T10:00:00Z", from: "david", text: "turn-A" },
    { ts: "2026-06-01T10:01:00Z", from: "דיגיט", text: "התחלתי שיחה חדשה — noise" },
    { ts: "2026-06-01T11:00:00Z", from: "david", text: "turn-B" },
    { ts: "2026-06-01T12:00:00Z", from: "david", text: "turn-C" },
  ];
  const md = formatRecentMd(recs, 2, 300, cfgDigit);
  assert.ok(!md.includes("turn-A"));
  assert.ok(md.includes("turn-B"));
  assert.ok(md.includes("turn-C"));
});
test("digit decideLog captures senderE164 and fromMe=false for a received group msg from another number", () => {
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: "G@g.us", content: "שלום", timestamp: "2026-05-30T20:00:00.000Z",
    metadata: { senderE164: "972500000001", senderId: "972500000001@s.whatsapp.net", to: "972500000000" } } };
  const d = decideLog(ev, cfgBase({ ...cfgDigit, groupId: "G@g.us" }));
  assert.equal(d.log, true);
  assert.equal(d.e164, "972500000001");
  assert.equal(d.fromMe, false);
});
test("digit decideLog includes inbound messageId; null when absent; undefined for outbound", () => {
  assert.equal(decideLog(digitEv("received"), cfgDigit).messageId, "M1");
  assert.equal(decideLog(digitEv("received", { messageId: undefined }), cfgDigit).messageId, null);
  assert.equal(decideLog(digitEv("sent", { content: "x" }), cfgDigit).messageId, undefined);
});
test("digit decideLog marks fromMe when sender == own number (owner self-chat)", () => {
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: "G@g.us", content: "hi",
    metadata: { senderE164: "972500000000", to: "972500000000" } } };
  assert.equal(decideLog(ev, cfgBase({ ...cfgDigit, groupId: "G@g.us" })).fromMe, true);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// JOBSCOUT (scout collapse + people roster default) + PITZI (media) + shared mechanics
// ════════════════════════════════════════════════════════════════════════════════════════════════

test("jobscout classify: scout report from Scotty collapses; chat survives", () => {
  assert.equal(classify({ from: "scotty", text: "🔵 בוקר טוב David! מצאתי 2 משרות" }, cfgJobscout), "scout");
  assert.equal(classify({ from: "scotty", text: "Daily scout complete: 2 sent" }, cfgJobscout), "internal");
  assert.equal(classify({ from: "david", text: "תודה" }, cfgJobscout), "chat");
});

test("jobscout formatRecentMd: scout run collapses to a 'סריקה יומית' marker", () => {
  const recs = [
    { ts: "2026-06-01T08:00:00Z", from: "scotty", speaker: "Scotty", text: "🔵 בוקר טוב David! 0 חדשות" },
    { ts: "2026-06-01T09:00:00Z", from: "david", text: "מה נשמע" },
  ];
  const md = formatRecentMd(recs, 30, 600, cfgJobscout);
  assert.ok(md.includes("סריקה יומית"));
  assert.ok(md.includes("מה נשמע"));
});

test("jobscout formatRecentMd: legacy david/scotty records render names without speaker field", () => {
  const recs = [
    { ts: "2026-06-01T09:00:00Z", from: "david", text: "שלום" },
    { ts: "2026-06-01T09:01:00Z", from: "scotty", text: "היי David" },
  ];
  const md = formatRecentMd(recs, 30, 600, cfgJobscout);
  assert.match(md, /\*\*David\*\*/);
  assert.match(md, /\*\*Scotty\*\*/);
});

test("extractMedia: legacy adapter shapes (back-compat)", () => {
  assert.deepEqual(extractMedia({ attachments: ["/a/b.jpg"] }), [{ path: "/a/b.jpg" }]);
  const m = extractMedia({ metadata: { media: [{ path: "/x.png", mimetype: "image/png", filename: "x.png" }] } });
  assert.equal(m[0].path, "/x.png");
  assert.equal(m[0].type, "image/png");
  assert.equal(m[0].name, "x.png");
  assert.deepEqual(extractMedia({}), []);
});

test("extractMedia: real gateway metadata.mediaPath (single)", () => {
  const m = extractMedia({ metadata: {
    mediaPath: "/home/x/.openclaw/media/inbound/uuid.ogg",
    mediaType: "audio/ogg", mediaFileName: "voice.ogg",
    mediaUrl: "https://x/uuid.ogg",
  } });
  assert.equal(m.length, 1);
  assert.equal(m[0].path, "/home/x/.openclaw/media/inbound/uuid.ogg");
  assert.equal(m[0].type, "audio/ogg");
  assert.equal(m[0].name, "voice.ogg");
  assert.equal(m[0].url, "https://x/uuid.ogg");
});

test("extractMedia: real gateway metadata.mediaPaths (array, zipped with types)", () => {
  const m = extractMedia({ metadata: {
    mediaPaths: ["/m/a.jpg", "/m/b.pdf"],
    mediaTypes: ["image/jpeg", "application/pdf"],
  } });
  assert.equal(m.length, 2);
  assert.equal(m[0].path, "/m/a.jpg");
  assert.equal(m[0].type, "image/jpeg");
  assert.equal(m[1].path, "/m/b.pdf");
  assert.equal(m[1].type, "application/pdf");
  // a single mediaFileName is NOT force-applied onto a multi-item message
  assert.equal(m[0].name, undefined);
});

test("mediaKind + mediaPlaceholderText: sensible Hebrew for each kind", () => {
  assert.equal(mediaKind({ type: "audio/ogg" }), "audio");
  assert.equal(mediaKind({ path: "/x/voice.opus" }), "audio");
  assert.equal(mediaKind({ path: "/x/pic.JPG" }), "image");
  assert.equal(mediaKind({ name: "deed.pdf" }), "document");
  assert.equal(mediaPlaceholderText([{ type: "audio/ogg" }]), "[הקלטה קולית]");
  assert.equal(mediaPlaceholderText([{ path: "/x/pic.jpg" }]), "[תמונה]");
  assert.equal(mediaPlaceholderText([{ name: "deed.pdf" }]), "[קובץ: deed.pdf]");
  assert.equal(mediaPlaceholderText([{ path: "/a" }, { path: "/b" }]), "[2 קבצים]");
});

test("displayTextFor: caption wins; placeholder/empty → Hebrew media text", () => {
  assert.equal(displayTextFor("שלום", []), "שלום");
  assert.equal(displayTextFor("<media:image>", [{ type: "image/jpeg" }]), "[תמונה]");
  assert.equal(displayTextFor("", [{ type: "audio/ogg" }]), "[הקלטה קולית]");
  assert.equal(displayTextFor("look at this", [{ type: "image/jpeg" }]), "look at this");
  assert.ok(MEDIA_PLACEHOLDER_RE.test("<media:audio>"));
  assert.ok(!MEDIA_PLACEHOLDER_RE.test("real caption"));
});

test("decideLog: real media-only event (any bot) archives-ready refs + Hebrew placeholder text", () => {
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: "<media:audio>", messageId: "M9",
    timestamp: "2026-06-13T20:00:00.000Z",
    metadata: { senderE164: "972500000003", to: "972500000000",
      mediaPath: "/m/uuid.ogg", mediaType: "audio/ogg" } } };
  const d = decideLog(ev, cfgDigit); // NOT a media-flag bot — still extracts media now
  assert.equal(d.log, true);
  assert.equal(d.text, "[הקלטה קולית]");
  assert.equal(d.media.length, 1);
  assert.equal(d.media[0].path, "/m/uuid.ogg");
});

test("pitzi decideLog: media-only message logs with media placeholder text", () => {
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: "", messageId: "M9",
    timestamp: "2026-06-13T20:00:00.000Z",
    metadata: { senderE164: "972500000003", to: "972500000000", senderName: "רונית", media: [{ path: "/m/1.jpg" }] } } };
  const d = decideLog(ev, cfgPitzi);
  assert.equal(d.log, true);
  assert.equal(d.from, "customer");
  assert.match(d.text, /\[תמונה\]/);
  assert.equal(d.media.length, 1);
  assert.equal(d.name, "רונית");
});

test("pitzi decideLog: no text AND no media → not logged", () => {
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: "", metadata: { senderE164: "1", to: "2" } } };
  assert.equal(decideLog(ev, cfgPitzi).log, false);
});

test("recordFileFor keys the jsonl off the group id", () => {
  assert.equal(recordFileFor(GROUP, cfgPoker), `/tmp/${GROUP}.jsonl`);
});

// ── resolveSpeaker roster tests (filesystem) ─────────────────────────────────────────────────────

test("resolveSpeaker players: matches by e164 digits, else default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-players-"));
  const pf = join(dir, "players.json");
  await writeFile(pf, JSON.stringify({ players: [{ id: "p1", name: "דני", e164: ["+972-50-000-0001"] }] }));
  const cfg = cfgBase({ roster: { type: "players", playersPath: pf }, labels: { ...cfgPoker.labels } });
  assert.equal((await resolveSpeaker("972500000001", cfg)).name, "דני");
  assert.equal((await resolveSpeaker("972500009999", cfg)).name, "שחקן");
  assert.equal((await resolveSpeaker(undefined, cfg)).name, "שחקן");
  await rm(dir, { recursive: true, force: true });
});

test("resolveSpeaker members: matches members.jsonl, falls back to players.json then default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-members-"));
  const mf = join(dir, "members.jsonl");
  const pf = join(dir, "players.json");
  await writeFile(mf, JSON.stringify({ e164: "972500000001", member_name: "יוסי" }) + "\n");
  await writeFile(pf, JSON.stringify({ players: [{ id: "p2", name: "מגיב-פולבק", e164: ["972500000002"] }] }));
  const cfg = cfgBase({ roster: { type: "members", membersPath: mf, playersPath: pf }, labels: { ...cfgZorro.labels } });
  assert.equal((await resolveSpeaker("972500000001", cfg)).name, "יוסי");        // members hit
  assert.equal((await resolveSpeaker("972500000002", cfg)).name, "מגיב-פולבק");   // players fallback
  assert.equal((await resolveSpeaker("972500009999", cfg)).name, "חבר");          // default
  await rm(dir, { recursive: true, force: true });
});

test("resolveSpeaker none: uses event-provided name, else default", async () => {
  const cfg = cfgBase({ roster: { type: "none" }, labels: { ...cfgPitzi.labels } });
  assert.equal((await resolveSpeaker("972500000001", cfg, { eventName: "רונית" })).name, "רונית");
  assert.equal((await resolveSpeaker("972500000001", cfg, {})).name, "לקוח");
});

// ── writeLog integration (side effects in a temp dir) ────────────────────────────────────────────

test("writeLog: appends jsonl, regenerates RECENT_CHAT.md, writes last-inbound.json (poker shape)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-writelog-"));
  const pf = join(dir, "players.json");
  await writeFile(pf, JSON.stringify({ players: [{ id: "p1", name: "דני", e164: ["972500000001"] }] }));
  const cfg = cfgBase({
    ...cfgPoker,
    roster: { type: "players", playersPath: pf },
    recentWindow: 10,
    paths: {
      configPath: "/nonexistent.json",
      dataDir: join(dir, "chat-log"),
      recentMd: join(dir, "RECENT_CHAT.md"),
      lastInbound: join(dir, "last-inbound.json"),
    },
  });
  await writeLog(inbound("דילר כמה אני בפלוס?"), cfg);

  const jsonl = await readFile(join(dir, "chat-log", `${GROUP}.jsonl`), "utf8");
  const rec = JSON.parse(jsonl.trim());
  assert.equal(rec.from, "player");
  assert.equal(rec.speaker, "דני");
  assert.equal(rec.text, "דילר כמה אני בפלוס?");

  const md = await readFile(join(dir, "RECENT_CHAT.md"), "utf8");
  assert.match(md, /\*\*דני\*\*/);

  const li = JSON.parse(await readFile(join(dir, "last-inbound.json"), "utf8"));
  assert.equal(li.e164, "972500000001");
  assert.equal(li.fromMe, false);
  assert.equal(li.speaker, "דני");           // players shape uses `speaker`
  assert.equal(li.messageId, "MID1");
  await rm(dir, { recursive: true, force: true });
});

test("writeLog: pitzi shape writes media + name in record and last-inbound (source missing → archived:false)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-pitzi-"));
  const cfg = cfgBase({
    ...cfgPitzi,
    recentWindow: 10,
    paths: {
      configPath: "/nonexistent.json",
      dataDir: join(dir, "chat-log"),
      mediaDir: join(dir, "media"),
      workspaceDir: dir,
      recentMd: join(dir, "RECENT_CHAT.md"),
      lastInbound: join(dir, "last-inbound.json"),
    },
  });
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: "יש בעיה", messageId: "M9",
    timestamp: "2026-06-13T20:00:00.000Z",
    metadata: { senderE164: "972500000003", to: "972500000000", senderName: "רונית", media: [{ path: "/m/1.jpg" }] } } };
  await writeLog(ev, cfg);

  const rec = JSON.parse((await readFile(join(dir, "chat-log", `${GROUP}.jsonl`), "utf8")).trim());
  assert.equal(rec.from, "customer");
  assert.equal(rec.speaker, "רונית");
  assert.equal(rec.name, "רונית");
  assert.equal(rec.media.length, 1);
  assert.equal(rec.media[0].originalName, "1.jpg");
  assert.equal(rec.media[0].archived, false);     // source /m/1.jpg does not exist
  assert.equal(rec.media[0].archivedPath, null);
  assert.equal(rec.conversation, GROUP);

  const li = JSON.parse(await readFile(join(dir, "last-inbound.json"), "utf8"));
  assert.equal(li.name, "רונית");
  assert.equal(li.person, null); // original pitzi handler wrote person:null
  assert.equal(li.media[0].archived, false);
  await rm(dir, { recursive: true, force: true });
});

test("writeLog: archives a real media file for a NON-media-flag bot (universal archiving)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-archive-"));
  // stage a fake inbound media file (as the gateway would drop in ~/.openclaw/media/inbound)
  const srcDir = join(dir, "inbound");
  await mkdir(srcDir, { recursive: true });
  const src = join(srcDir, "abc.ogg");
  await writeFile(src, "OPUSDATA");
  const cfg = cfgBase({
    ...cfgDigit, // digit has NO media flag — archiving must still happen
    recentWindow: 10,
    paths: {
      configPath: "/nonexistent.json",
      dataDir: join(dir, "chat-log"),
      mediaDir: join(dir, "media"),
      workspaceDir: dir,
      recentMd: join(dir, "RECENT_CHAT.md"),
      lastInbound: join(dir, "last-inbound.json"),
    },
  });
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: "<media:audio>", messageId: "MID9",
    timestamp: "2026-06-13T20:00:00.000Z",
    metadata: { senderE164: "972500000001", to: "972500000000", mediaPath: src, mediaType: "audio/ogg" } } };
  await writeLog(ev, cfg);

  const rec = JSON.parse((await readFile(join(dir, "chat-log", `${GROUP}.jsonl`), "utf8")).trim());
  assert.equal(rec.text, "[הקלטה קולית]");
  assert.equal(rec.media.length, 1);
  assert.equal(rec.media[0].archived, true);
  assert.equal(rec.media[0].mimetype, "audio/ogg");
  assert.match(rec.media[0].archivedPath, /^media\/120363000000000000@g\.us\//);
  // the file really exists under the archive and keeps its bytes
  const copied = await readFile(join(dir, rec.media[0].archivedPath), "utf8");
  assert.equal(copied, "OPUSDATA");
  await rm(dir, { recursive: true, force: true });
});

test("writeLog: archiveMedia:false opts a bot out (media referenced, not copied)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-noarchive-"));
  const srcDir = join(dir, "inbound");
  await mkdir(srcDir, { recursive: true });
  const src = join(srcDir, "x.jpg");
  await writeFile(src, "JPGDATA");
  const cfg = cfgBase({
    ...cfgDigit, archiveMedia: false, recentWindow: 10,
    paths: {
      configPath: "/nonexistent.json",
      dataDir: join(dir, "chat-log"),
      mediaDir: join(dir, "media"),
      workspaceDir: dir,
      recentMd: join(dir, "RECENT_CHAT.md"),
      lastInbound: join(dir, "last-inbound.json"),
    },
  });
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: GROUP, content: "<media:image>", messageId: "MID10",
    timestamp: "2026-06-13T20:00:00.000Z",
    metadata: { senderE164: "972500000001", to: "972500000000", mediaPath: src, mediaType: "image/jpeg" } } };
  await writeLog(ev, cfg);
  const rec = JSON.parse((await readFile(join(dir, "chat-log", `${GROUP}.jsonl`), "utf8")).trim());
  // opted out → no media[] on the record, and nothing copied into the archive dir
  assert.equal(rec.media, undefined);
  assert.equal(existsSync(join(dir, "media")), false);
  await rm(dir, { recursive: true, force: true });
});

test("writeLog: digit single-user shape writes person:null in last-inbound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-digit-"));
  const cfg = cfgBase({
    ...cfgDigit,
    recentWindow: 10,
    paths: {
      configPath: "/nonexistent.json",
      dataDir: join(dir, "chat-log"),
      recentMd: join(dir, "RECENT_CHAT.md"),
      lastInbound: join(dir, "last-inbound.json"),
    },
  });
  await writeLog(inbound("שלום דיגיט"), cfg);
  const li = JSON.parse(await readFile(join(dir, "last-inbound.json"), "utf8"));
  assert.equal(li.person, null);
  assert.equal(li.e164, "972500000001");
  await rm(dir, { recursive: true, force: true });
});

test("writeLog: never throws on a bad event", async () => {
  await writeLog(null, cfgPoker);          // not a message
  await writeLog(inbound("hi", { conv: "x@g.us" }), cfgPoker); // wrong group → no-op
  assert.ok(true);
});

// ── inbound dedup (RUNBOOK vendored patch #4 safety) ─────────────────────────────────────────────

test("tailHasMessageId: matches an existing id, misses others, never throws on a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-tailid-"));
  const file = join(dir, "g.jsonl");
  assert.equal(await tailHasMessageId(file, "M1"), false);        // no file yet → false, no throw
  await writeFile(file, JSON.stringify({ ts: "t", from: "player", text: "a", messageId: "M1" }) + "\n");
  assert.equal(await tailHasMessageId(file, "M1"), true);
  assert.equal(await tailHasMessageId(file, "M2"), false);
  assert.equal(await tailHasMessageId(file, undefined), false);    // no id → never dedups
  await rm(dir, { recursive: true, force: true });
});

test("writeLog: a repeated inbound (same messageId) is logged once, not duplicated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cl-dedup-"));
  const pf = join(dir, "players.json");
  await writeFile(pf, JSON.stringify({ players: [{ id: "p1", name: "דני", e164: ["972500000001"] }] }));
  const cfg = cfgBase({
    ...cfgPoker,
    roster: { type: "players", playersPath: pf },
    recentWindow: 10,
    paths: {
      configPath: "/nonexistent.json",
      dataDir: join(dir, "chat-log"),
      recentMd: join(dir, "RECENT_CHAT.md"),
      lastInbound: join(dir, "last-inbound.json"),
    },
  });
  const ev = inbound("דילר כמה אני בפלוס?", { id: "DUP1" });
  await writeLog(ev, cfg);
  await writeLog(ev, cfg);   // duplicate message:received for the exact same inbound → must be skipped

  const jsonl = await readFile(join(dir, "chat-log", `${GROUP}.jsonl`), "utf8");
  const lines = jsonl.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "duplicate inbound must not append a second record");
  assert.equal(JSON.parse(lines[0]).messageId, "DUP1", "inbound record carries its messageId for dedup");

  // A genuinely different message (distinct id) still logs.
  await writeLog(inbound("ועוד שאלה", { id: "DUP2" }), cfg);
  const after = (await readFile(join(dir, "chat-log", `${GROUP}.jsonl`), "utf8")).split("\n").filter(Boolean);
  assert.equal(after.length, 2, "a distinct inbound still appends");
  await rm(dir, { recursive: true, force: true });
});
