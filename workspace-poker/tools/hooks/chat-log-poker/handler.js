import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const BASE = "/home/davidtobol2580/open_claw/workspace-poker";
const CONFIG_PATH = `${BASE}/.config/bot.json`;
const PLAYERS_PATH = `${BASE}/data/players.json`;
const DATA_DIR = `${BASE}/data/chat-log`;
const RECENT_MD = `${BASE}/RECENT_CHAT.md`;
const LAST_INBOUND = `${BASE}/data/last-inbound.json`;
const BOT = "דילר";

/** Should this event be logged? Only WhatsApp messages in the configured group with text. */
export function decideLog(event, groupId) {
  const no = (reason) => ({ log: false, reason });
  if (!event || event.type !== "message") return no("not a message");
  if (event.action !== "received" && event.action !== "sent") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  if (!groupId || ctx.conversationId !== groupId) return no("other conversation");
  const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
  if (!text) return no("empty content");
  const meta = ctx.metadata ?? {};
  const e164 = (meta.senderE164 || meta.senderId || "").toString().replace(/@.*/, "").replace(/\D/g, "") || undefined;
  const ownE164 = (meta.to || "").toString().replace(/\D/g, "") || undefined;
  const fromMe = !!(e164 && ownE164 && e164 === ownE164);
  return {
    log: true,
    inbound: event.action === "received",
    text,
    ts: typeof ctx.timestamp === "string" ? ctx.timestamp : undefined,
    e164: event.action === "received" ? e164 : undefined,
    fromMe: event.action === "received" ? fromMe : undefined,
    messageId: event.action === "received" ? (ctx.messageId ?? null) : undefined,
  };
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

export function classify(r) {
  const t = (r?.text || "").trim();
  if (/^התחלתי שיחה חדשה/.test(t)) return "reset";
  return "chat";
}

function fmtDate(ts) {
  const parts = (ts || "").slice(0, 10).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : (ts || "").slice(0, 10);
}

/** Render the recent conversation, newest last. Bot replies capped; background events collapsed. */
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
    const isBot = r.speaker === BOT || r.from === BOT;
    const who = r.speaker || (isBot ? BOT : "שחקן");
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
/** Best-effort: resolve an inbound sender's display name from the player registry by e164. */
async function resolveSpeaker(e164) {
  if (!e164) return "שחקן";
  try {
    const { players } = JSON.parse(await readFile(PLAYERS_PATH, "utf8"));
    const hit = (players || []).find((p) => (p.e164 || []).some((e) => String(e).replace(/\D/g, "") === e164));
    return hit?.name || "שחקן";
  } catch { return "שחקן"; }
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

/** Hook entry — append to the full record, then regenerate RECENT_CHAT.md. Never throws. */
export default async function chatLog(event) {
  try {
    const groupId = await resolveGroupId();
    if (!groupId) return;
    const d = decideLog(event, groupId);
    if (!d.log) return;

    const speaker = d.inbound ? await resolveSpeaker(d.e164) : BOT;
    if (d.inbound && (d.e164 !== undefined || d.fromMe)) {
      try {
        await writeFile(LAST_INBOUND, JSON.stringify({
          e164: d.e164 ?? null,
          fromMe: !!d.fromMe,
          speaker,
          ts: d.ts || new Date().toISOString(),
          messageId: d.messageId ?? null,
        }));
      } catch { /* best-effort */ }
    }

    const record = { ts: d.ts || new Date().toISOString(), from: d.inbound ? "player" : BOT, speaker, text: d.text };
    const file = recordFileFor(groupId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n");
    const window = await resolveWindow();
    const recs = await readTailRecords(file, window * 2);
    await writeFile(RECENT_MD, formatRecentMd(recs, window));
  } catch {
    // best-effort: a chat-log failure must never block message processing
  }
}

export { CONFIG_PATH, DATA_DIR, RECENT_MD };
