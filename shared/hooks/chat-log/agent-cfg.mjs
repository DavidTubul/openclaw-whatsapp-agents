// shared/hooks/chat-log/agent-cfg.mjs
//
// Map a normalized agent-registry record (shared/lib/agent-registry.mjs) → the `agentCfg`
// shape that shared/lib/chat-log.mjs#writeLog consumes. This is the ONE place that bridges the
// registry's record shape to the chat-log lib's per-agent config, so every per-bot parameter
// (labels, roster paths, e164 normalization, media flag, scout classification, the pitzi Sheet
// mirror) lives here, derived from the registry — not duplicated per workspace.
//
// The produced agentCfg is verified against shared/lib/chat-log.test.mjs's per-bot fixtures
// (cfgJobscout/cfgDigit/cfgPoker/cfgZorro/cfgPitzi) so behavior is preserved exactly:
//   - main  : labels{inboundFrom:"david", outboundFrom:"scotty", inboundSpeakerDefault:"אורח",
//             botSpeaker:"Scotty"}, roster people, classifyScout:true, e164DigitsOnly:false
//   - digit : labels{...David...}, roster none, e164DigitsOnly:false (single-user; multi-group)
//   - poker : labels{inboundFrom:"player", default:"שחקן"}, roster players, e164DigitsOnly:true
//   - zorro : labels{inboundFrom:"member", default:"חבר"}, roster members(+players fallback),
//             e164DigitsOnly:true
//   - pitzi : labels{inboundFrom:"customer", default:"לקוח"}, roster none, media:true, onRecord→Sheet
//
// Pure (no I/O) EXCEPT it returns an `onRecord` closure for pitzi that performs the best-effort
// Google-Sheet "Chats" mirror (the lib calls it; it never throws). All paths are absolute,
// derived from the record's workspaceDir / dataDir / configPath.

import { readFile } from "node:fs/promises";
import { pushToSheet } from "../../lib/sheet-webhook.mjs";

// ── per-agent presentation config ──────────────────────────────────────────────────────────────
// PRECEDENCE (per key): registry record's optional `chatLog.labels` block → derived defaults from
// the record's fromLabel/persona/owner. The hardcoded per-agent LABELS table was removed 2026-07-17:
// each bot's presentation labels now live in its shared/registry.json `chatLog.labels` block (the
// exact per-agent overrides on top of the derived defaults), so a NEW bot needs NOTHING here —
// registering it in shared/registry.json alone yields a fully working chat-log.
//
// Legacy label quirks (now carried by the registry chatLog.labels blocks, verified byte-identical by
// handler.test.mjs against the live registry):
//   - main's outbound `from` tag is lowercase "scotty" (records used from:"scotty"), while its
//     botSpeaker display is "Scotty"; its inbound display default is "אורח" (unknown guest).
//   - poker/zorro/pitzi carry role-based inbound labels (player/member/customer + שחקן/חבר/לקוח).

// poker/zorro pre-strip the stored e164 to bare digits; the others keep the raw (sans @-suffix).
const E164_DIGITS_ONLY = { poker: true, zorro: true };

// only jobscout collapses its daily scout reports out of the recent window.
const CLASSIFY_SCOUT = { main: true };

// only pitzi logs media refs + mirrors to a Sheet.
const MEDIA = { pitzi: true };

// per-agent legacy persona aliases: names a bot used BEFORE a rename, still present in old chat-log
// records. isBotRecord() matches these so historical lines render correctly during the transition.
// poker was "דילר" before it became "דאוס" (785 outbound records on disk are stamped "דילר").
const LEGACY_BOT_NAMES = { poker: ["דילר"] };

/** Derived default labels for any bot, from the registry record's fromLabel/persona/owner. Per-agent
 *  quirks (main's "scotty"/"Scotty"/"אורח", poker/zorro/pitzi role labels, digit's "David") come from
 *  the record's `chatLog.labels` overrides, applied on top of these by agentCfgFromRecord. */
function derivedLabels(rec) {
  const name = (rec.persona && rec.persona.name) || rec.agentId;
  const ownerLabel = (rec.owner && rec.owner.label) || "owner";
  const fl = rec.fromLabel || {};
  return {
    inboundFrom: fl.inbound || ownerLabel,
    outboundFrom: fl.outbound || name,
    inboundSpeakerDefault: ownerLabel,
    botSpeaker: name,
  };
}

// ── pitzi best-effort Google Sheet "Chats" mirror (ported from chat-log-pitzi/handler.js) ─────────

/** Build the "Chats" Sheet row from a chat-log record. Pure. Mirrors the original chatSheetRow(). */
export function chatSheetRow(rec) {
  const inbound = rec.from === "customer";
  return {
    ts: rec.ts,
    conversation: rec.conversation || "",
    direction: inbound ? "לקוח→פיצי" : "פיצי→לקוח",
    name: inbound ? (rec.name || "") : "פיצי",
    phone: inbound ? (rec.e164 || "") : "",
    text: rec.text || "",
  };
}

/**
 * Best-effort live push of one record to the Google Sheet "Chats" tab. Never throws, bounded by a
 * 4s timeout — same semantics as the original pitzi handler's pushChatToSheet(), now via the ONE
 * shared webhook client. Reads the agent's bot.json (configPath) for sheet.enabled + webhook_url.
 */
async function pushChatToSheet(rec, configPath) {
  let cfg;
  try { cfg = JSON.parse(await readFile(configPath, "utf8")); } catch { return; }
  // webhook down / disabled → row stays in JSONL; repair with `sheet-sync.mjs backfill`
  await pushToSheet(cfg?.sheet, "append-chat", chatSheetRow(rec), { timeoutMs: 4000 });
}

/**
 * Map an agent-registry record → the chat-log lib's agentCfg.
 * Returns null ONLY for a missing/id-less record; any registered agent gets a working config
 * (registry `chatLog` overrides → legacy tables → derived defaults).
 */
export function agentCfgFromRecord(rec) {
  if (!rec || !rec.agentId) return null;
  const id = rec.agentId;
  const cl = rec.chatLog || {};
  const labels = { ...derivedLabels(rec), ...(cl.labels || {}) };

  const botName = (rec.persona && rec.persona.name) || labels.botSpeaker;

  // roster: translate the registry's {type,file,fallbackFile} into the lib's path keys.
  const r = rec.roster || { type: "none" };
  const roster = { type: r.type || "none" };
  if (roster.type === "people")  roster.peoplePath = r.file;
  if (roster.type === "players") roster.playersPath = r.file;
  if (roster.type === "members") {
    roster.membersPath = r.file;
    if (r.fallbackFile) roster.playersPath = r.fallbackFile; // zorro → players.json fallback
  }

  // `media` (legacy, pitzi) drives the extra Sheet-mirror record columns + last-inbound media.
  const media = cl.media ?? !!MEDIA[id];
  // `archiveMedia` drives the universal durable media archive (copy inbound files into
  // data/media/<group>/). Default ON for EVERY bot; opt out per-agent via chatLog.archiveMedia:false.
  const archiveMedia = cl.archiveMedia ?? true;

  const cfg = {
    agentId: id,
    botName,
    labels,
    legacyBotNames: cl.legacyBotNames || LEGACY_BOT_NAMES[id] || [],
    // digit serves >1 group; everyone else has a single primary group. groupIds always present
    // on the record (loader fills it from primaryGroupId when absent), so use it uniformly.
    groupIds: rec.groupIds && rec.groupIds.length ? rec.groupIds.slice() : [rec.primaryGroupId],
    e164DigitsOnly: cl.e164DigitsOnly ?? !!E164_DIGITS_ONLY[id],
    roster,
    classifyScout: cl.classifyScout ?? !!CLASSIFY_SCOUT[id],
    media,
    archiveMedia,
    paths: {
      configPath: rec.configPath,
      dataDir: `${rec.dataDir}/chat-log`,
      mediaDir: `${rec.dataDir}/media`,
      workspaceDir: rec.workspaceDir,
      recentMd: `${rec.workspaceDir}/RECENT_CHAT.md`,
      lastInbound: `${rec.dataDir}/last-inbound.json`,
    },
    // recentWindow comes from the registry (record.sessionHygiene.recent_window) — the ONE source of
    // truth. Previously the chat-log lib read session_hygiene.recent_window from the workspace config;
    // that block was removed from the configs 2026-07-17, so we pass it here instead (the lib's
    // resolveWindow uses this when finite, else falls back to 30 for a bot without a hygiene block).
    recentWindow: rec.sessionHygiene?.recent_window,
    maxReply: 600,
  };

  // Best-effort live Sheet mirror ("Chats" tab), wired through the lib's onRecord hook.
  // Registry `chatLog.sheetMirror` opts a bot in; pitzi is the legacy default.
  if (cl.sheetMirror ?? (id === "pitzi")) {
    cfg.onRecord = (record, ac) => pushChatToSheet(record, ac.paths.configPath);
  }

  return cfg;
}

export default agentCfgFromRecord;
