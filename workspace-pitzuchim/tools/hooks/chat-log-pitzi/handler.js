import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG_PATH = "/home/davidtobol2580/open_claw/workspace-pitzuchim/.config/bot.json";
const DATA_DIR = "/home/davidtobol2580/open_claw/workspace-pitzuchim/data/chat-log";
const RECENT_MD = "/home/davidtobol2580/open_claw/workspace-pitzuchim/RECENT_CHAT.md";
const LAST_INBOUND = "/home/davidtobol2580/open_claw/workspace-pitzuchim/data/last-inbound.json";

/**
 * Best-effort extraction of inbound media references from an event.
 * OpenClaw downloads inbound media to ~/.openclaw/media/inbound/. The exact event
 * field is adapter-dependent, so we probe several common shapes and return whatever
 * we find. The Q&A prompt ALSO falls back to scanning the inbound dir by mtime, so a
 * miss here is non-fatal — this just makes correlation more robust when present.
 */
export function extractMedia(ctx) {
  const out = [];
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

/** Should this event be logged, and as whom? WhatsApp messages in the configured group; text OR media. */
export function decideLog(event, groupId) {
  const no = (reason) => ({ log: false, reason });
  if (!event || event.type !== "message") return no("not a message");
  if (event.action !== "received" && event.action !== "sent") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  if (!groupId || ctx.conversationId !== groupId) return no("other conversation");
  const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
  const media = extractMedia(ctx);
  if (!text && media.length === 0) return no("empty content");
  const meta = ctx.metadata ?? {};
  const e164 = (meta.senderE164 || meta.senderId || "").toString().replace(/@.*/, "") || undefined;
  const ownE164 = (meta.to || "").toString().trim() || undefined;
  const fromMe = !!(e164 && ownE164 && e164.replace(/\D/g, "") === ownE164.replace(/\D/g, ""));
  // WhatsApp display name (best-effort across adapter shapes) — so the human view shows WHO, not just a number.
  const name = (meta.senderName || meta.pushName || meta.notifyName || meta.senderDisplayName || meta.displayName || "")
    .toString().trim() || undefined;
  return {
    log: true,
    from: event.action === "received" ? "customer" : "פיצי",
    text: text || (media.length ? `[מדיה: ${media.length} קבצים]` : ""),
    media,
    ts: typeof ctx.timestamp === "string" ? ctx.timestamp : undefined,
    conversation: ctx.conversationId,
    e164: event.action === "received" ? e164 : undefined,
    name: event.action === "received" ? name : undefined,
    fromMe: event.action === "received" ? fromMe : undefined,
    messageId: event.action === "received" ? (ctx.messageId ?? null) : undefined,
  };
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/** Continuity classifier: reset notices collapse to a marker; everything else is real chat. */
export function classify(r) {
  const t = (r?.text || "").trim();
  if (/^התחלתי שיחה חדשה/.test(t)) return "reset";
  return "chat";
}

function fmtDate(ts) {
  const parts = (ts || "").slice(0, 10).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : (ts || "").slice(0, 10);
}

/** Render the recent conversation as Markdown, newest last. */
export function formatRecentMd(records, n, maxReply = 600) {
  const merged = [];
  for (const r of records) {
    const kind = classify(r);
    if (kind === "chat") { merged.push({ type: "chat", r }); continue; }
    const last = merged[merged.length - 1];
    if (last && last.type === "marker") { last.kinds.add(kind); last.ts = r.ts || last.ts; }
    else merged.push({ type: "marker", kinds: new Set([kind]), ts: r.ts });
  }
  let chatSeen = 0, start = merged.length;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].type === "chat") { chatSeen++; if (chatSeen > n) break; }
    start = i;
  }
  const tail = merged.slice(start);
  const lines = tail.map((m) => {
    if (m.type === "marker") return `— [${fmtDate(m.ts)} · אירוע רקע] —`;
    const r = m.r;
    const isBot = r.from === "פיצי" || r.speaker === "פיצי";
    const who = r.speaker || (r.from === "customer" ? "לקוח" : "פיצי");
    const text = isBot ? truncate(r.text, maxReply) : r.text;
    const when = (r.ts || "").replace("T", " ").replace(/\..*$/, "");
    return `**${who}** (${when}): ${text}`;
  });
  const chatCount = tail.filter((m) => m.type === "chat").length;
  return `# שיחות אחרונות (${chatCount})\n\n` + lines.join("\n\n") + "\n";
}

async function resolveGroupId() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"))?.whatsapp?.group_id;
}
async function resolveWindow() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"))?.session_hygiene?.recent_window ?? 30;
}
function recordFileFor(groupId) { return `${DATA_DIR}/${groupId}.jsonl`; }

async function readTailRecords(file, maxLines) {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

/**
 * Build the "Chats" Sheet row from a chat-log record. Pure → unit-testable.
 * Columns mirror sheet-sync.mjs CHAT_FIELDS and the Apps Script "Chats" tab.
 */
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

/** Best-effort live push of one message to the Google Sheet "Chats" tab. Never throws, bounded by a timeout. */
async function pushChatToSheet(rec) {
  let cfg;
  try { cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8")); } catch { return; }
  if (!cfg?.sheet?.enabled || !cfg?.sheet?.webhook_url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(cfg.sheet.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "append-chat", row: chatSheetRow(rec) }),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch { /* webhook down → row stays in JSONL; repair with `sheet-sync.mjs backfill` */ }
  finally { clearTimeout(timer); }
}

/** Hook entry — append to the full record, then regenerate RECENT_CHAT.md. Never throws. */
export default async function chatLog(event) {
  try {
    const groupId = await resolveGroupId();
    const d = decideLog(event, groupId);
    if (!d.log) return;

    const speaker = d.from === "customer" ? "לקוח" : "פיצי";
    if (d.from === "customer" && (d.e164 !== undefined || d.fromMe || (d.media && d.media.length))) {
      try {
        await writeFile(LAST_INBOUND, JSON.stringify({
          e164: d.e164 ?? null,
          name: d.name ?? null,
          fromMe: !!d.fromMe,
          person: null,
          ts: d.ts || new Date().toISOString(),
          messageId: d.messageId ?? null,
          media: d.media ?? [],
        }));
      } catch { /* best-effort */ }
    }

    const record = {
      ts: d.ts || new Date().toISOString(),
      from: d.from, speaker, text: d.text, media: d.media ?? [],
      conversation: d.conversation || groupId,
      e164: d.e164 ?? null, name: d.name ?? null,
    };
    const file = recordFileFor(groupId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n");
    const window = await resolveWindow();
    const recs = await readTailRecords(file, window * 2);
    await writeFile(RECENT_MD, formatRecentMd(recs, window));
    await pushChatToSheet(record); // best-effort live mirror to the Sheet "Chats" tab
  } catch {
    // best-effort: a chat-log failure must never block message processing
  }
}

export { CONFIG_PATH, DATA_DIR, RECENT_MD };
