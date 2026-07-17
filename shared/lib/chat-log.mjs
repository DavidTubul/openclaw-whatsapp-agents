// shared/lib/chat-log.mjs — UNIFIED, parameterized chat-log logic for all OpenClaw agents.
//
// This module factors the five duplicated `tools/hooks/chat-log-*/handler.js` copies into one
// place. Pure decision logic is separated from side effects so it is unit-testable. Every function
// takes an `agentCfg` record (NOT the registry — the caller resolves it and passes it in) so the
// pure functions never touch the filesystem unless told to.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// agentCfg shape (a per-agent record; the thin per-bot handler builds it and passes it in):
// {
//   agentId:   "main" | "digit" | "poker" | "pitzi" | "zorro",   // identity only (audit/clarity)
//   botName:   "Scotty" | "דיגיט" | "דילר" | "פיצי" | "זורו",     // outbound speaker label
//
//   // --- labels: how a record's `from`/`speaker` are stamped + rendered ---------------------------
//   labels: {
//     // `from` field stamped on the record (the legacy "side" tag):
//     inboundFrom:  "david" | "player" | "customer" | "member",   // role tag for inbound
//     outboundFrom: <botName>,                                      // role tag for outbound (== botName)
//     // default display name when the roster can't resolve an inbound sender:
//     inboundSpeakerDefault: "David" | "שחקן" | "לקוח" | "חבר" | "אורח",
//     botSpeaker: <botName>,                                        // outbound display name (== botName)
//   },
//
//   // --- group(s) this agent serves --------------------------------------------------------------
//   groupId:  "<id>@g.us"            // single-group bots
//   // OR
//   groupIds: ["<id>@g.us", ...]     // multi-group bots (digit). If present, takes precedence.
//
//   // --- e164 normalization in decideLog ---------------------------------------------------------
//   // jobscout/digit/pitzi keep the raw e164 (only strips the @-suffix); poker/zorro pre-strip to
//   // bare digits. Downstream comparisons always strip \D, so this only affects the stored e164.
//   e164DigitsOnly: false (jobscout/digit/pitzi) | true (poker/zorro),
//
//   // --- roster: how an inbound sender's display name is resolved --------------------------------
//   roster: {
//     type: "people" | "players" | "members" | "none",
//     // 'people':  read peoplePath (.config/people.json) → personByE164(e164,{fromMe}) → name
//     // 'players': read playersPath (data/players.json) → match by e164 → name
//     // 'members': read membersPath (data/streaks/members.jsonl) → match by e164 → member_name,
//     //            with playersPath as a fallback roster (NOTE: original zorro had NO fallback;
//     //            the prompt asks for a players.json fallback, kept opt-in via playersPath)
//     // 'none':    fall back to the event-provided name (pitzi) or the default speaker
//     peoplePath:  "<ws>/.config/people.json",
//     playersPath: "<ws>/data/players.json",
//     membersPath: "<ws>/data/streaks/members.jsonl",
//   },
//
//   // --- classification (continuity windowing) ---------------------------------------------------
//   classifyScout: false (everyone) | true (jobscout only — collapses daily scout reports),
//
//   // --- feature flags ---------------------------------------------------------------------------
//   media: false | true (pitzi — log media refs + media marker text),
//
//   // --- paths -----------------------------------------------------------------------------------
//   paths: {
//     configPath: "<ws>/.config/<bot>.json",   // read for recent_window (session_hygiene.recent_window)
//     dataDir:    "<ws>/data/chat-log",         // <dataDir>/<group>.jsonl
//     recentMd:   "<ws>/RECENT_CHAT.md",
//     lastInbound:"<ws>/data/last-inbound.json",
//   },
//
//   recentWindow: 30,        // optional override; else read from configPath.session_hygiene.recent_window (def 30)
//   maxReply: 600,           // optional; the formatRecentMd bot-reply cap (all bots use 600)
// }
// ───────────────────────────────────────────────────────────────────────────────────────────────

import { readFile, appendFile, mkdir, copyFile } from "node:fs/promises";
import { writeFileAtomic } from "./fs-atomic.mjs";
import { existsSync } from "node:fs";
import { dirname, basename, join, relative } from "node:path";

const digits = (s) => String(s ?? "").replace(/\D/g, "");

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/**
 * Best-effort extraction of inbound media references from an event context.
 *
 * PRIMARY (real OpenClaw gateway shape): `message:received` events carry media on
 * `ctx.metadata` as `mediaPath` (string) / `mediaPaths` (array) with parallel
 * `mediaType`/`mediaTypes` (mimetype) and `mediaUrl`/`mediaUrls`, plus a single
 * `mediaFileName`. This is what live events actually send — the previous version probed
 * only adapter shapes that never exist on real events, so media was NEVER logged.
 *
 * FALLBACK (legacy/adapter shapes, kept for back-compat + existing unit fixtures):
 * ctx.attachments / ctx.media / ctx.metadata.attachments / ctx.metadata.media, with item
 * keys path/localPath/filePath/file/url + type/mimetype/mimeType/kind + name/filename/fileName.
 *
 * Returns [{ path?, type?, name?, url? }]; a miss is non-fatal (empty array).
 */
export function extractMedia(ctx) {
  const out = [];
  const meta = ctx?.metadata ?? {};

  // ── real gateway fields (metadata.mediaPath(s)/mediaType(s)/mediaUrl(s)/mediaFileName) ──
  const paths = Array.isArray(meta.mediaPaths) && meta.mediaPaths.length
    ? meta.mediaPaths
    : (meta.mediaPath ? [meta.mediaPath] : []);
  const types = Array.isArray(meta.mediaTypes) && meta.mediaTypes.length
    ? meta.mediaTypes
    : (meta.mediaType ? [meta.mediaType] : []);
  const urls = Array.isArray(meta.mediaUrls) && meta.mediaUrls.length
    ? meta.mediaUrls
    : (meta.mediaUrl ? [meta.mediaUrl] : []);
  const n = Math.max(paths.length, urls.length);
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      const item = {};
      if (paths[i]) item.path = paths[i];
      if (types[i]) item.type = types[i];
      if (urls[i]) item.url = urls[i];
      // a single mediaFileName only maps meaningfully onto a single-item message
      if (n === 1 && meta.mediaFileName) item.name = meta.mediaFileName;
      if (item.path || item.type || item.url || item.name) out.push(item);
    }
    if (out.length) return out;
  }

  // ── legacy adapter shapes (back-compat; exercised by unit fixtures) ──
  const cands = [ctx?.attachments, ctx?.media, ctx?.metadata?.attachments, ctx?.metadata?.media];
  for (const c of cands) {
    if (!c) continue;
    const arr = Array.isArray(c) ? c : [c];
    for (const m of arr) {
      if (!m) continue;
      if (typeof m === "string") { out.push({ path: m }); continue; }
      const path = m.path || m.localPath || m.filePath || m.file || m.url;
      const type = m.type || m.mimetype || m.mimeType || m.kind;
      const name = m.name || m.filename || m.fileName;
      if (path || type || name) out.push({ path, type, name });
    }
  }
  return out;
}

/** Literal caption-less placeholders the gateway puts in `content` for a media-only message. */
export const MEDIA_PLACEHOLDER_RE = /^<media:(image|video|audio|voice|ptt|document|sticker|file|gif)>$/i;

/** Coarse media kind from mimetype first, then filename/path extension. */
export function mediaKind(m) {
  const t = String(m?.type || "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "sticker") return "image";
  const src = String(m?.name || m?.path || m?.url || "").toLowerCase();
  const ext = src.includes(".") ? src.slice(src.lastIndexOf(".") + 1) : "";
  if (["jpg", "jpeg", "png", "webp", "gif", "heic", "bmp"].includes(ext)) return "image";
  if (["mp4", "mov", "3gp", "mkv", "webm", "avi"].includes(ext)) return "video";
  if (["ogg", "oga", "opus", "m4a", "mp3", "wav", "aac", "amr", "flac"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip"].includes(ext)) return "document";
  return "file";
}

/**
 * Human-readable Hebrew placeholder for a media message (used when there is no real caption).
 * Examples: `[תמונה]`, `[סרטון]`, `[הקלטה קולית]`, `[קובץ: report.pdf]`, `[3 קבצים]`.
 */
export function mediaPlaceholderText(media) {
  if (!Array.isArray(media) || media.length === 0) return "[מדיה]";
  if (media.length > 1) return `[${media.length} קבצים]`;
  const m = media[0];
  const name = m?.name || (m?.path ? basename(m.path) : "");
  switch (mediaKind(m)) {
    case "image":    return "[תמונה]";
    case "video":    return "[סרטון]";
    case "audio":    return "[הקלטה קולית]";
    case "document": return name ? `[קובץ: ${name}]` : "[מסמך]";
    default:         return name ? `[קובץ: ${name}]` : "[מדיה]";
  }
}

/**
 * The text to store/render for a message: a genuine caption wins; an empty body or a bare
 * `<media:x>` placeholder is replaced by a readable Hebrew media placeholder when media is present.
 */
export function displayTextFor(text, media) {
  const t = (typeof text === "string" ? text : "").trim();
  if (t && !MEDIA_PLACEHOLDER_RE.test(t)) return t;
  if (Array.isArray(media) && media.length) return mediaPlaceholderText(media);
  return t;
}

/**
 * Copy each inbound media file out of the ephemeral gateway store into the owning bot's durable
 * archive at <workspace>/data/media/<groupJid>/<utc-ts>-<messageId>-<idx>-<name>. Returns a media
 * array [{ archivedPath (relative to workspace), mimetype, originalName, archived }]. Never throws;
 * when the source file is missing/uncopyable the reference is still recorded with archived:false.
 */
async function archiveMedia(mediaItems, d, agentCfg) {
  const out = [];
  const mediaRoot = agentCfg.paths?.mediaDir;
  const wsDir = agentCfg.paths?.workspaceDir;
  const tsSafe = String(d.ts || new Date().toISOString()).replace(/[:.]/g, "-");
  const mid = String(d.messageId || "nomsg").replace(/[^\w.-]/g, "_");
  let idx = 0;
  for (const m of mediaItems) {
    const src = m?.path;
    const originalName = m?.name || (src ? basename(src) : `media-${idx}`);
    const safeName = String(originalName).replace(/[/\\\s]+/g, "_");
    let archivedPath = null, archived = false;
    if (src && mediaRoot && wsDir && existsSync(src)) {
      const groupDir = join(mediaRoot, d.groupId);
      const destAbs = join(groupDir, `${tsSafe}-${mid}-${idx}-${safeName}`);
      try {
        await mkdir(groupDir, { recursive: true });
        await copyFile(src, destAbs);
        archived = true;
        archivedPath = relative(wsDir, destAbs);
      } catch { archived = false; archivedPath = null; }
    }
    const entry = { archivedPath, mimetype: m?.type ?? null, originalName, archived };
    if (m?.url) entry.url = m.url;
    out.push(entry);
    idx++;
  }
  return out;
}

/** WhatsApp display name pulled from event metadata (best-effort across adapter shapes). */
function eventSenderName(meta) {
  return (meta.senderName || meta.pushName || meta.notifyName || meta.senderDisplayName || meta.displayName || "")
    .toString().trim() || undefined;
}

/**
 * Decide whether to log an event, and resolve the raw fields needed to build a record.
 * Mirrors all five originals:
 *  - only `type:"message"` with `action` in {received, sent}
 *  - only `channelId === "whatsapp"`
 *  - group gate: single `groupId` (string) or multi `groupIds` (array, digit) — the returned
 *    `groupId` is the conversation the message actually came from (so the caller keys the per-group
 *    record file + RECENT_CHAT off the active group, no cross-group mixing)
 *  - empty-content skip (pitzi: skip only when text AND media are both empty)
 *  - fromMe detection (sender e164 digits === own `to` digits)
 *  - inbound carries e164 / fromMe / messageId; outbound leaves them undefined
 *
 * Returns a normalized shape used by writeLog:
 *   { log, groupId, from, speaker:undefined, text, ts, e164, fromMe, messageId,
 *     inbound, media?, name?, conversation? }
 * (`speaker` is filled by writeLog after roster resolution; included here as undefined for clarity.)
 */
export function decideLog(event, agentCfg) {
  const no = (reason) => ({ log: false, reason });
  if (!event || event.type !== "message") return no("not a message");
  if (event.action !== "received" && event.action !== "sent") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);

  const ids = Array.isArray(agentCfg.groupIds) && agentCfg.groupIds.length
    ? agentCfg.groupIds
    : (agentCfg.groupId ? [agentCfg.groupId] : []);
  if (!ids.length || !ids.includes(ctx.conversationId)) return no("other conversation");

  const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
  // Media is extracted for EVERY agent now (archiving is universal), not just the pitzi media flag.
  const media = extractMedia(ctx);
  if (!text && media.length === 0) return no("empty content");

  const meta = ctx.metadata ?? {};
  const rawE164 = (meta.senderE164 || meta.senderId || "").toString().replace(/@.*/, "");
  const e164 = (agentCfg.e164DigitsOnly ? rawE164.replace(/\D/g, "") : rawE164) || undefined;
  const ownE164 = agentCfg.e164DigitsOnly
    ? ((meta.to || "").toString().replace(/\D/g, "") || undefined)
    : ((meta.to || "").toString().trim() || undefined);
  const fromMe = agentCfg.e164DigitsOnly
    ? !!(e164 && ownE164 && e164 === ownE164)
    : !!(e164 && ownE164 && digits(e164) === digits(ownE164));

  const inbound = event.action === "received";
  const labels = agentCfg.labels;
  const out = {
    log: true,
    inbound,
    groupId: ctx.conversationId,
    from: inbound ? labels.inboundFrom : labels.outboundFrom,
    speaker: undefined, // filled by writeLog after roster resolution
    text: displayTextFor(text, media),
    ts: typeof ctx.timestamp === "string" ? ctx.timestamp : undefined,
    e164: inbound ? e164 : undefined,
    fromMe: inbound ? fromMe : undefined,
    messageId: inbound ? (ctx.messageId ?? null) : undefined,
    media, // raw extracted refs; writeLog archives them into the durable store
  };
  if (agentCfg.media) {
    // pitzi-only presentation extras (drive the Google-Sheet "Chats" mirror columns)
    out.conversation = ctx.conversationId;
    out.name = inbound ? eventSenderName(meta) : undefined;
  }
  return out;
}

/**
 * Classify a record for continuity windowing.
 *  - "reset"    : the "started a fresh session" notice (all bots)
 *  - "scout"    : a daily scout report / heartbeat (jobscout only, classifyScout=true)
 *  - "internal" : an internal English pipeline/dev log that leaked (jobscout only)
 *  - "chat"     : a genuine conversational turn (the only thing that consumes the window)
 */
export function classify(r, agentCfg = {}) {
  const t = (r?.text || "").trim();
  if (/^התחלתי שיחה חדשה/.test(t)) return "reset";
  if (agentCfg.classifyScout) {
    const botName = agentCfg.botName || "Scotty";
    const isBot = r?.from === botName || r?.speaker === botName || r?.from === "scotty";
    if (isBot) {
      if (/^(@\d+\s+)?🔵\s*בוקר טוב/u.test(t)) return "scout";          // daily report / heartbeat
      if (/^Daily scout complete/i.test(t)) return "internal";          // pipeline status log
      if (/^The WhatsApp session isn'?t available/i.test(t)) return "internal";
    }
  }
  return "chat";
}

function fmtDate(ts) {
  const parts = (ts || "").slice(0, 10).split("-"); // [yyyy, mm, dd]
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : (ts || "").slice(0, 10);
}

/**
 * Render the recent conversation as Markdown, newest last. Genuine chat turns are kept in full
 * (bot replies capped at `maxReply`); runs of resets / scout reports / internal logs collapse into
 * a single compact marker so they don't evict real conversation. `n` counts conversational turns.
 *
 * Signature is back-compat with the originals: formatRecentMd(records, n, maxReply, agentCfg).
 * `agentCfg` is optional and only used for the bot-name + scout-classification labels; when omitted
 * the legacy Scotty-style markers/labels are used (so existing call sites keep working).
 */
export function formatRecentMd(records, n, maxReply = 600, agentCfg = {}) {
  const botName = agentCfg.botName;
  const inboundDefault = agentCfg.labels?.inboundSpeakerDefault;
  const scoutLabel = "סריקה יומית · דוח נשלח";
  const bgLabel = "אירוע רקע";

  // Collapse consecutive non-chat records into one marker each.
  const merged = [];
  for (const r of records) {
    const kind = classify(r, agentCfg);
    if (kind === "chat") { merged.push({ type: "chat", r }); continue; }
    const last = merged[merged.length - 1];
    if (last && last.type === "marker") {
      last.kinds.add(kind);
      last.ts = r.ts || last.ts;
    } else {
      merged.push({ type: "marker", kinds: new Set([kind]), ts: r.ts });
    }
  }
  // Keep the last `n` conversational turns; markers between/after them ride along for free.
  let chatSeen = 0, start = merged.length;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].type === "chat") { chatSeen++; if (chatSeen > n) break; }
    start = i;
  }
  const tail = merged.slice(start);
  const lines = tail.map((m) => {
    if (m.type === "marker") {
      const label = m.kinds.has("scout") ? scoutLabel : bgLabel;
      return `— [${fmtDate(m.ts)} · ${label}] —`;
    }
    const r = m.r;
    const isBot = isBotRecord(r, agentCfg);
    const who = r.speaker || (isBot ? (botName || "Scotty") : defaultInboundName(r, inboundDefault));
    const text = isBot ? truncate(r.text, maxReply) : r.text;
    const when = (r.ts || "").replace("T", " ").replace(/\..*$/, "");
    return `**${who}** (${when}): ${text}`;
  });
  const chatCount = tail.filter((m) => m.type === "chat").length;
  return `# שיחות אחרונות (${chatCount})\n\n` + lines.join("\n\n") + "\n";
}

/** Is this record a bot reply? Matches on speaker/from against the bot name + legacy "scotty". */
function isBotRecord(r, agentCfg) {
  const botName = agentCfg.botName;
  if (botName && (r.from === botName || r.speaker === botName)) return true;
  // legacy jobscout records used from:"scotty" / speaker:"Scotty"
  if (r.from === "scotty" || r.speaker === "Scotty") return true;
  // per-agent legacy persona aliases (e.g. poker renamed דילר→דאוס; old records stamped "דילר"
  // must still render as bot lines during the transition window). Configured in agent-cfg.mjs.
  const legacy = agentCfg.legacyBotNames;
  if (Array.isArray(legacy) && (legacy.includes(r.from) || legacy.includes(r.speaker))) return true;
  return false;
}

/** Display name for an inbound record when it has no `speaker` field. */
function defaultInboundName(r, inboundDefault) {
  // jobscout legacy: from "david" → "David"; everyone else → the configured default.
  if (r.from === "david") return "David";
  return inboundDefault || "אורח";
}

/** `<dataDir>/<group>.jsonl` */
export function recordFileFor(groupId, agentCfg) {
  return `${agentCfg.paths.dataDir}/${groupId}.jsonl`;
}

// ── roster resolution (side-effecting: reads roster files; never throws → falls back) ────────────

/**
 * Resolve an inbound sender's display name from the agent's roster.
 *  - 'people' : .config/people.json via personByE164(e164,{fromMe}); name or "אורח"
 *  - 'players': data/players.json; match e164 (digits) → name or default
 *  - 'members': data/streaks/members.jsonl; match e164 → member_name; optional players.json fallback
 *  - 'none'   : event-provided name (opts.eventName) or default
 * Returns { name, personId } — personId is non-null only for the 'people' roster (used in last-inbound).
 */
export async function resolveSpeaker(e164, agentCfg, opts = {}) {
  const roster = agentCfg.roster || { type: "none" };
  const def = agentCfg.labels?.inboundSpeakerDefault ?? "אורח";
  const fromMe = !!opts.fromMe;

  if (roster.type === "people") {
    // Same matching semantics as jobscout's personByE164 (owner-by-fromMe, then match_e164), read
    // directly from roster.peoplePath — the shared lib must not import FROM a workspace (inverted
    // dependency), and the registry-supplied peoplePath used to be dead config.
    const person = await matchPeople(roster.peoplePath, e164, fromMe);
    return { name: person ? person.name : def, personId: person?.id ?? null };
  }

  if (roster.type === "players") {
    const name = await matchPlayers(roster.playersPath, e164, def);
    return { name, personId: null };
  }

  if (roster.type === "members") {
    const m = await matchMembers(roster.membersPath, e164, def);
    if (m !== def) return { name: m, personId: null };
    // optional players.json fallback (prompt asks for it; original zorro had none → only if path set)
    if (roster.playersPath) {
      const p = await matchPlayers(roster.playersPath, e164, def);
      return { name: p, personId: null };
    }
    return { name: def, personId: null };
  }

  // 'none' — event-provided name (pitzi) or default
  return { name: opts.eventName || def, personId: null };
}

async function matchPeople(peoplePath, e164, fromMe) {
  if (!peoplePath) return null;
  let reg; try { reg = JSON.parse(await readFile(peoplePath, "utf8")); } catch { return null; }
  const people = reg.people || [];
  if (fromMe) {
    const owner = people.find((p) => p.role === "owner" && p.enabled);
    if (owner) return owner;
  }
  const d = digits(e164);
  if (d) {
    const m = people.find(
      (p) => p.enabled && Array.isArray(p.match_e164) && p.match_e164.some((x) => digits(x) === d),
    );
    if (m) return m;
  }
  return null;
}

async function matchPlayers(playersPath, e164, def) {
  if (!e164 || !playersPath) return def;
  const d = digits(e164);
  try {
    const { players } = JSON.parse(await readFile(playersPath, "utf8"));
    const hit = (players || []).find((p) => (p.e164 || []).some((e) => digits(e) === d));
    return hit?.name || def;
  } catch { return def; }
}

async function matchMembers(membersPath, e164, def) {
  if (!e164 || !membersPath) return def;
  const d = digits(e164);
  try {
    const raw = await readFile(membersPath, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let m; try { m = JSON.parse(t); } catch { continue; }
      const memE164 = digits(m?.e164 ?? "");
      if (memE164 && memE164 === d) return m?.member_name || def;
    }
    return def;
  } catch { return def; }
}

// ── config / tail readers ─────────────────────────────────────────────────────────────────────

async function resolveWindow(agentCfg) {
  if (Number.isFinite(agentCfg.recentWindow)) return agentCfg.recentWindow;
  try {
    const cfg = JSON.parse(await readFile(agentCfg.paths.configPath, "utf8"));
    return cfg?.session_hygiene?.recent_window ?? 30;
  } catch { return 30; }
}

/** Read back the last `maxLines` records for re-render. */
async function readTailRecords(file, maxLines) {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

/**
 * Inbound dedup guard: has an inbound record with this exact `messageId` already been logged in the
 * recent tail of the group's jsonl? A cheap tail read (last `maxLines` records, default 50) — never
 * throws (a read/parse miss returns false → we log rather than lose a message). This protects against
 * a future upstream re-adding the dispatch-site message:received emit (RUNBOOK vendored patch #4):
 * if both the extension seam AND core dispatch ever fire for the same inbound, the second event is
 * dropped here instead of producing a duplicate chat-log line. Records without a `messageId` (older
 * entries, outbound, listen-export) never collide, so this only ever suppresses a true duplicate.
 */
export async function tailHasMessageId(file, messageId, maxLines = 50) {
  if (!messageId) return false;
  try {
    const recs = await readTailRecords(file, maxLines);
    return recs.some((r) => r && r.messageId === messageId);
  } catch {
    return false;
  }
}

// ── the side-effecting entry point ──────────────────────────────────────────────────────────────

/**
 * Append the message to the per-group JSONL, regenerate RECENT_CHAT.md, write last-inbound.json.
 * Never throws — a chat-log failure must never block message processing.
 *
 * Preserves each bot's last-inbound.json shape:
 *  - people  (jobscout): { e164, fromMe, person, ts, messageId }
 *  - players (poker):    { e164, fromMe, speaker, ts, messageId }
 *  - members (zorro):    { e164, fromMe, speaker, ts, messageId }
 *  - none + single-user (digit): { e164, fromMe, person:null, ts, messageId }
 *  - none + media (pitzi): { e164, name, fromMe, person:null, ts, messageId, media }
 *
 * And each bot's record shape:
 *  - jobscout/digit: { ts, from, speaker, text }
 *  - poker/zorro:    { ts, from, speaker, text }  (from = "player"/"member" inbound, botName outbound)
 *  - pitzi:          { ts, from, speaker, text, media, conversation, e164, name }
 */
export async function writeLog(event, agentCfg) {
  try {
    const d = decideLog(event, agentCfg);
    if (!d.log) return;

    // Inbound dedup: skip an inbound message we've already logged (matched by messageId in the recent
    // tail). Cheap, never-throws; guards against a duplicate message:received event for the same
    // inbound (see tailHasMessageId + RUNBOOK vendored patch #4). Only inbound records carry a
    // messageId, so this never suppresses a distinct outbound/older line.
    if (d.inbound && d.messageId) {
      const existingFile = recordFileFor(d.groupId, agentCfg);
      if (await tailHasMessageId(existingFile, d.messageId)) return;
    }

    const labels = agentCfg.labels;
    let speaker, personId = null;
    if (d.inbound) {
      const res = await resolveSpeaker(d.e164, agentCfg, { fromMe: d.fromMe, eventName: d.name });
      speaker = res.name;
      personId = res.personId;
    } else {
      speaker = labels.botSpeaker;
    }

    // Archive inbound media out of the ephemeral gateway store into the bot's durable
    // data/media/<group>/. Universal (all agents) unless the registry opts out
    // (chatLog.archiveMedia:false). Never throws — a copy failure yields archived:false refs.
    let archived = [];
    if (agentCfg.archiveMedia !== false && d.media && d.media.length) {
      try { archived = await archiveMedia(d.media, d, agentCfg); } catch { archived = []; }
    }

    // last-inbound.json — only for inbound, gated like each original.
    const mediaPresent = agentCfg.media && d.media && d.media.length;
    if (d.inbound && (d.e164 !== undefined || d.fromMe || mediaPresent)) {
      const li = {
        e164: d.e164 ?? null,
        fromMe: !!d.fromMe,
        ts: d.ts || new Date().toISOString(),
        messageId: d.messageId ?? null,
      };
      // shape selection mirrors the originals
      if (agentCfg.roster?.type === "people") {
        li.person = personId;
      } else if (agentCfg.roster?.type === "players" || agentCfg.roster?.type === "members") {
        li.speaker = speaker;
      } else {
        // 'none' bots wrote person:null
        li.person = null;
      }
      if (agentCfg.media) {
        li.name = d.name ?? null;
        li.media = archived;
      }
      // field ordering for media bot matched original (e164,name,fromMe,person,ts,messageId,media)
      try { writeFileAtomic(agentCfg.paths.lastInbound, JSON.stringify(li)); } catch { /* best-effort */ }
    }

    // build the record (media bot carries extra columns; every bot now carries a media[] when present)
    const record = { ts: d.ts || new Date().toISOString(), from: d.from, speaker, text: d.text };
    // Stamp the inbound messageId onto the record so the dedup guard above can recognise a repeat of
    // this exact message on a future event (never set for outbound — message:sent has no messageId).
    if (d.inbound && d.messageId) record.messageId = d.messageId;
    if (agentCfg.media) {
      record.media = archived;
      record.conversation = d.conversation || d.groupId;
      record.e164 = d.e164 ?? null;
      record.name = d.name ?? null;
    } else if (archived.length) {
      record.media = archived;
    }

    const file = recordFileFor(d.groupId, agentCfg);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n");

    const window = await resolveWindow(agentCfg);
    const recs = await readTailRecords(file, window * 2);
    writeFileAtomic(agentCfg.paths.recentMd, formatRecentMd(recs, window, agentCfg.maxReply ?? 600, agentCfg));

    // optional best-effort live mirror (pitzi Google Sheet); supplied by the caller as a hook.
    if (typeof agentCfg.onRecord === "function") {
      try { await agentCfg.onRecord(record, agentCfg); } catch { /* best-effort */ }
    }
  } catch {
    // best-effort: a chat-log failure must never block message processing
  }
}

export default writeLog;
