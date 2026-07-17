// shared/hooks/chat-log/handler.test.mjs — tests for the unified chat-log hook + record→cfg mapper.
// Run: node --test shared/hooks/chat-log/handler.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCfgFromRecord, chatSheetRow } from "./agent-cfg.mjs";
import chatLog, { resolveAgentCfg } from "./handler.js";
import { getAgent, getAgentByGroup, listAgents } from "../../lib/agent-registry.mjs";

// ── agentCfgFromRecord: per-bot shape matches the live handlers / chat-log.test.mjs fixtures ──────

test("agentCfgFromRecord: main (Scotty) — people roster, scout, scotty/Scotty labels", () => {
  const cfg = agentCfgFromRecord(getAgent("main"));
  assert.equal(cfg.agentId, "main");
  assert.equal(cfg.botName, "סקוטי");
  assert.deepEqual(cfg.labels, {
    inboundFrom: "david", outboundFrom: "scotty", inboundSpeakerDefault: "אורח", botSpeaker: "Scotty",
  });
  assert.equal(cfg.roster.type, "people");
  assert.match(cfg.roster.peoplePath, /workspace-jobscout\/.config\/people\.json$/);
  assert.equal(cfg.classifyScout, true);
  assert.equal(cfg.e164DigitsOnly, false);
  assert.equal(cfg.media, false);
  assert.equal(cfg.onRecord, undefined);
  assert.match(cfg.paths.dataDir, /workspace-jobscout\/data\/chat-log$/);
  assert.match(cfg.paths.recentMd, /workspace-jobscout\/RECENT_CHAT\.md$/);
  assert.match(cfg.paths.lastInbound, /workspace-jobscout\/data\/last-inbound\.json$/);
});

test("agentCfgFromRecord: digit — none roster, multi-group, David default", () => {
  const cfg = agentCfgFromRecord(getAgent("digit"));
  assert.equal(cfg.agentId, "digit");
  assert.equal(cfg.labels.inboundSpeakerDefault, "David");
  assert.equal(cfg.roster.type, "none");
  assert.equal(cfg.e164DigitsOnly, false);
  // both groups present + the secondary group resolves back to digit
  assert.equal(cfg.groupIds.length, 2);
  assert.equal(getAgentByGroup(cfg.groupIds[1]).agentId, "digit");
});

test("agentCfgFromRecord: poker — players roster, e164DigitsOnly, player/שחקן", () => {
  const cfg = agentCfgFromRecord(getAgent("poker"));
  assert.equal(cfg.agentId, "poker");
  assert.equal(cfg.labels.inboundFrom, "player");
  assert.equal(cfg.labels.inboundSpeakerDefault, "שחקן");
  assert.equal(cfg.labels.outboundFrom, "דאוס");
  assert.equal(cfg.labels.botSpeaker, "דאוס");
  assert.equal(cfg.roster.type, "players");
  assert.match(cfg.roster.playersPath, /workspace-poker\/data\/players\.json$/);
  assert.equal(cfg.e164DigitsOnly, true);
});

test("agentCfgFromRecord: zorro — members roster + players.json fallback, e164DigitsOnly", () => {
  const cfg = agentCfgFromRecord(getAgent("zorro"));
  assert.equal(cfg.agentId, "zorro");
  assert.equal(cfg.labels.inboundFrom, "member");
  assert.equal(cfg.labels.inboundSpeakerDefault, "חבר");
  assert.equal(cfg.roster.type, "members");
  assert.match(cfg.roster.membersPath, /workspace-quitsmoke\/data\/streaks\/members\.jsonl$/);
  assert.match(cfg.roster.playersPath, /workspace-quitsmoke\/data\/players\.json$/); // fallback
  assert.equal(cfg.e164DigitsOnly, true);
});

test("agentCfgFromRecord: pitzi — none roster, media:true, onRecord Sheet hook", () => {
  // pitzi is archived (retired 2026-07-17) → getAgent hides it by default; use the escape hatch to
  // verify the record-derivation shape still resolves correctly for a future revival.
  const cfg = agentCfgFromRecord(getAgent("pitzi", { includeArchived: true }));
  assert.equal(cfg.agentId, "pitzi");
  assert.equal(cfg.labels.inboundFrom, "customer");
  assert.equal(cfg.labels.inboundSpeakerDefault, "לקוח");
  assert.equal(cfg.media, true);
  assert.equal(typeof cfg.onRecord, "function");
});

test("agentCfgFromRecord: null/id-less → null; UNKNOWN agent now gets working derived defaults", () => {
  // Changed 2026-07-02: an unknown-but-registered agentId used to return null (silent no-op
  // chat-log for a 6th bot). It now derives a working config; agent-cfg.test.mjs covers the shape.
  assert.equal(agentCfgFromRecord(null), null);
  assert.equal(agentCfgFromRecord({}), null);
  const cfg = agentCfgFromRecord({ agentId: "nope", workspaceDir: "/w", dataDir: "/w/data", primaryGroupId: "1@g.us", groupIds: ["1@g.us"] });
  assert.ok(cfg && cfg.botName === "nope");
});

test("chatSheetRow: pitzi inbound vs outbound direction/name/phone", () => {
  const inb = chatSheetRow({ from: "customer", ts: "t", conversation: "c", name: "דנה", e164: "972500000001", text: "שלום" });
  assert.equal(inb.direction, "לקוח→פיצי");
  assert.equal(inb.name, "דנה");
  assert.equal(inb.phone, "972500000001");
  const out = chatSheetRow({ from: "פיצי", ts: "t", conversation: "c", text: "תודה" });
  assert.equal(out.direction, "פיצי→לקוח");
  assert.equal(out.name, "פיצי");
  assert.equal(out.phone, "");
});

// ── resolveAgentCfg: routes by conversation id, no-ops on unknown ─────────────────────────────────

test("resolveAgentCfg: known group → that agent; unknown / missing → null", () => {
  const pokerGid = getAgent("poker").primaryGroupId;
  assert.equal(resolveAgentCfg({ context: { conversationId: pokerGid } }).agentId, "poker");
  assert.equal(resolveAgentCfg({ context: { conversationId: "999@g.us" } }), null);
  assert.equal(resolveAgentCfg({}), null);
  assert.equal(resolveAgentCfg(null), null);
});

// ── chatLog end-to-end against a temp dir (verifies delegation actually writes) ───────────────────

test("chatLog: writes jsonl + RECENT_CHAT.md + last-inbound.json for the resolving agent", async () => {
  // Use the real poker record but redirect its paths into a temp dir so we don't touch the live ws.
  const dir = await mkdtemp(join(tmpdir(), "chatlog-hook-"));
  const pokerGid = getAgent("poker").primaryGroupId;
  const cfg = agentCfgFromRecord(getAgent("poker"));
  cfg.paths = {
    configPath: "/nonexistent.json",
    dataDir: join(dir, "chat-log"),
    recentMd: join(dir, "RECENT_CHAT.md"),
    lastInbound: join(dir, "last-inbound.json"),
  };
  await mkdir(cfg.paths.dataDir, { recursive: true });

  // Drive the lib directly with our redirected cfg (matches what the hook does after resolution).
  const { default: writeLog } = await import("../../lib/chat-log.mjs");
  const ev = { type: "message", action: "received", context: {
    channelId: "whatsapp", conversationId: pokerGid, content: "דאוס כמה אני בפלוס?",
    messageId: "MID9", timestamp: "2026-06-26T10:00:00.000Z",
    metadata: { senderE164: "972500000001", to: "972500000000" },
  } };
  await writeLog(ev, cfg);

  const jsonl = await readFile(join(cfg.paths.dataDir, `${pokerGid}.jsonl`), "utf8");
  const rec = JSON.parse(jsonl.trim());
  assert.equal(rec.from, "player");
  assert.equal(rec.text, "דאוס כמה אני בפלוס?");
  const md = await readFile(cfg.paths.recentMd, "utf8");
  assert.match(md, /שיחות אחרונות/);
  const li = JSON.parse(await readFile(cfg.paths.lastInbound, "utf8"));
  assert.equal(li.e164, "972500000001");   // poker stores bare digits
  assert.equal(li.fromMe, false);
  assert.ok("speaker" in li);              // players roster → speaker shape

  await rm(dir, { recursive: true, force: true });
});

test("chatLog: never throws on a junk event", async () => {
  await chatLog(null);
  await chatLog({ type: "message", action: "received", context: { conversationId: "999@g.us" } });
  assert.ok(true);
});

test("registry sanity: all 5 agents map to a non-null cfg", () => {
  for (const rec of listAgents()) {
    const cfg = agentCfgFromRecord(rec);
    assert.ok(cfg, `cfg for ${rec.agentId}`);
    assert.equal(cfg.agentId, rec.agentId);
  }
});
