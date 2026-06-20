import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { personByE164 } from "/home/davidtobol2580/open_claw/workspace-jobscout/tools/lib/people.mjs";

const CONFIG_PATH = "/home/davidtobol2580/open_claw/workspace-jobscout/.config/job-scout.json";
const DATA_DIR = "/home/davidtobol2580/open_claw/workspace-jobscout/data/chat-log";
const RECENT_MD = "/home/davidtobol2580/open_claw/workspace-jobscout/RECENT_CHAT.md";
const LAST_INBOUND = "/home/davidtobol2580/open_claw/workspace-jobscout/data/last-inbound.json";

/** Should this event be logged, and as whom? Only WhatsApp messages in the configured group with text. */
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
  const e164 = (meta.senderE164 || meta.senderId || "").toString().replace(/@.*/, "") || undefined;
  const ownE164 = (meta.to || "").toString().trim() || undefined;
  const fromMe = !!(e164 && ownE164 && e164.replace(/\D/g, "") === ownE164.replace(/\D/g, ""));
  return {
    log: true,
    from: event.action === "received" ? "david" : "scotty",
    text,
    ts: typeof ctx.timestamp === "string" ? ctx.timestamp : undefined,
    e164: event.action === "received" ? e164 : undefined,
    fromMe: event.action === "received" ? fromMe : undefined,
    // Inbound WhatsApp message id (same field ack-react reads) so Q&A can issue
    // quoted replies via `--reply-to`. Null-safe when the event carries no id.
    messageId: event.action === "received" ? (ctx.messageId ?? null) : undefined,
  };
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/**
 * Classify a record for continuity purposes:
 *  - "scout"    : a daily scout report / heartbeat (owner or guest) — high-volume noise
 *  - "reset"    : the "started a fresh session" notice
 *  - "internal" : an internal English pipeline/dev log that leaked to the group
 *  - "chat"     : a genuine conversational turn (the only thing worth keeping in full)
 * Only "chat" records consume the conversational window; the rest are collapsed to a marker.
 */
export function classify(r) {
  const t = (r?.text || "").trim();
  const isScotty = r?.from === "scotty" || r?.speaker === "Scotty";
  if (/^התחלתי שיחה חדשה/.test(t)) return "reset";
  if (isScotty) {
    if (/^(@\d+\s+)?🔵\s*בוקר טוב/u.test(t)) return "scout";           // daily report / heartbeat
    if (/^Daily scout complete/i.test(t)) return "internal";            // pipeline status log
    if (/^The WhatsApp session isn'?t available/i.test(t)) return "internal";
  }
  return "chat";
}

function fmtDate(ts) {
  const parts = (ts || "").slice(0, 10).split("-"); // [yyyy, mm, dd]
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : (ts || "").slice(0, 10);
}

/**
 * Render the recent conversation as Markdown, newest last.
 * Genuine chat turns are kept in full (Scotty replies capped at `maxReply`); runs of
 * scout reports / resets / internal logs are collapsed into a single compact marker so
 * they don't evict real conversation from the window. `n` counts conversational turns.
 */
export function formatRecentMd(records, n, maxReply = 600) {
  // Collapse consecutive non-chat records into one marker each.
  const merged = [];
  for (const r of records) {
    const kind = classify(r);
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
      const label = m.kinds.has("scout") ? "סריקה יומית · דוח נשלח" : "אירוע רקע";
      return `— [${fmtDate(m.ts)} · ${label}] —`;
    }
    const r = m.r;
    // speaker field takes precedence; fall back to legacy from field
    const isScotty = r.from === "scotty" || r.speaker === "Scotty";
    const who = r.speaker || (r.from === "david" ? "David" : "Scotty");
    const text = isScotty ? truncate(r.text, maxReply) : r.text;
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

/** Read back the last `maxLines` records for re-render. */
async function readTailRecords(file, maxLines) {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

/** Hook entry — append the message to the full record, then regenerate RECENT_CHAT.md. Never throws. */
export default async function chatLog(event) {
  try {
    const groupId = await resolveGroupId();
    const d = decideLog(event, groupId);
    if (!d.log) return;

    let speaker = d.from === "scotty" ? "Scotty" : "David";
    if (d.from !== "scotty" && (d.e164 !== undefined || d.fromMe)) {
      let person = null;
      try { person = personByE164(d.e164, { fromMe: !!d.fromMe }); } catch { /* registry missing → ignore */ }
      speaker = person ? person.name : "אורח";
      try {
        await writeFile(LAST_INBOUND, JSON.stringify({
          e164: d.e164 ?? null,
          fromMe: !!d.fromMe,
          person: person?.id ?? null,
          ts: d.ts || new Date().toISOString(),
          messageId: d.messageId ?? null,
        }));
      } catch { /* best-effort */ }
    }

    const record = { ts: d.ts || new Date().toISOString(), from: d.from, speaker, text: d.text };
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
