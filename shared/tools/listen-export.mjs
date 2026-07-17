#!/usr/bin/env node
// shared/tools/listen-export.mjs — drain a listen-only group's shadow-agent transcript into a
// digit chat-log so the daily reflect pipeline can distil it into memory.
//
// A group in listen-only mode is routed to the shadow agent `listener`, which NEVER runs
// (unmatchable mention pattern).
// OpenClaw still writes every inbound group message in realtime into that agent's session transcript
// (JSONL, v3). This tool copies those inbound user messages, in the existing chat-log line format,
// into workspace-realestate/data/chat-log/<group>.jsonl — the exact file shared/tools/reflect.mjs
// already reads. From there the nightly reflect distils them into digit's group-notes memory.
//
// SAFETY / ERROR PHILOSOPHY: this runs from a 15-minute systemd oneshot; a failed export must NEVER
// break the unit into failure spam. So it catches EVERYTHING, prints one concise line to stderr, and
// exits 0 regardless. When there is nothing to do (listener has no sessions yet, no source file, or
// no new lines) it is a clean no-op: one "nothing new" summary line, exit 0. It only ever APPENDS to
// the chat-log and rewrites its own state file — it touches nothing else (never openclaw.json,
// credentials, or the gateway).
//
// INCREMENTAL / ROTATION: a state file (data/.listen-export-state.json) stores the byte offset
// already consumed per source session-file path, plus the last seen sessionFile path. On each run it
// re-reads sessions.json to find the CURRENT session file, then drains every known file that has
// grown past its stored offset (the current one, plus any older rotated files whose tail was not yet
// consumed) — older files first so cross-file order stays chronological. When OpenClaw rotates to a
// brand-new session file the old file's remaining tail is drained one final time and the new file is
// read from offset 0.
//
// Usage:
//   node shared/tools/listen-export.mjs
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, mkdirSync, renameSync,
  copyFileSync,
} from 'node:fs';
import { dirname, basename, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { mediaPlaceholderText, MEDIA_PLACEHOLDER_RE } from '../lib/chat-log.mjs';
import { listAgents, getAgent, getGroupByName } from '../lib/agent-registry.mjs';

// ---- wiring: derived from the registry (shared/registry.json) -------------------------------------
// This tool is now GENERIC: it serves EVERY listen-only group owned by any answering agent (an
// agent's `listenGroups` in the registry). For each such group it drains the shadow `listener`
// agent's session transcript into the OWNING agent's chat-log. Nothing is hardcoded — the group jid,
// the owning workspace dir, the owner phone, the listener sessions path and session key all come from
// the registry record. (Historically it hardcoded digit's single listen group + host-absolute paths.)

// The runtime owner phone always comes from the owning agent's registry record (rec.owner.e164).
// There is deliberately NO hardcoded fallback number: with no ownerNumber, sessionLineToEntry
// still detects the owner via the senderIsOwner flag.
const DEFAULT_OWNER_NUMBER = '';

/** Expand a leading `~` in a registry sessionStore path to the user's home dir. */
function expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) return join(homedir(), p.slice(1));
  return p;
}

/**
 * Build the list of listen-export targets from the registry: one entry per (owning agent, listen
 * group). Each target carries everything the plumbing needs, all registry-derived. Never throws
 * (returns [] on any registry problem). The state file keeps the LEGACY unsuffixed name for an
 * agent's FIRST listen group (so existing offsets survive) and a per-jid suffix for any further ones.
 */
export function buildTargets() {
  const targets = [];
  let agents;
  try { agents = listAgents(); } catch { return targets; }
  for (const rec of agents) {
    const listenSyms = Array.isArray(rec.listenGroups) ? rec.listenGroups : [];
    if (!listenSyms.length) continue;
    const ws = rec.workspaceDir;
    const ownerNumber = (rec.owner && rec.owner.e164) || DEFAULT_OWNER_NUMBER;
    listenSyms.forEach((sym, i) => {
      const g = getGroupByName(sym);
      const jid = g && g.jid;
      if (!jid) return;
      const listenerId = (g && g.routeAgentId) || 'listener';
      const listenerRec = getAgent(listenerId);
      const sessionStore = listenerRec ? expandHome(listenerRec.sessionStore) : null;
      if (!sessionStore) return;
      targets.push({
        agentId: rec.agentId,
        ownerNumber,
        workspaceDir: ws,
        groupJid: jid,
        sessionsJson: join(sessionStore, 'sessions.json'),
        sessionKey: `agent:${listenerId}:whatsapp:group:${jid}`,
        chatLog: `${ws}/data/chat-log/${jid}.jsonl`,
        mediaDir: `${ws}/data/media`,
        stateFile: i === 0
          ? `${ws}/data/.listen-export-state.json`
          : `${ws}/data/.listen-export-state-${jid}.json`,
      });
    });
  }
  return targets;
}

// ---- pure transform (exported for tests) ---------------------------------------------------------

/** Digits-only view of a phone-ish string, e.g. "+972-50 000 0001" -> "972500000001". */
export function digitsOnly(s) {
  return typeof s === 'string' ? s.replace(/\D+/g, '') : '';
}

/**
 * Pull the plain text out of a v3 message.content, which may be a string or an array of parts.
 * Text parts look like { type: 'text', text: '...' }; non-text parts are ignored. Returns a trimmed
 * string ('' when there is no usable text).
 */
export function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

/**
 * Extract media refs from a v3 session message. Agent session transcripts use CAPITALIZED keys on
 * the message object: `MediaPath` (string) / `MediaPaths` (array) with parallel `MediaType(s)`.
 * Returns [{ path, type }] (raw staged paths; the caller archives + rewrites them).
 */
export function extractSessionMedia(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const paths = Array.isArray(msg.MediaPaths) && msg.MediaPaths.length
    ? msg.MediaPaths
    : (msg.MediaPath ? [msg.MediaPath] : []);
  const types = Array.isArray(msg.MediaTypes) && msg.MediaTypes.length
    ? msg.MediaTypes
    : (msg.MediaType ? [msg.MediaType] : []);
  const out = [];
  for (let i = 0; i < paths.length; i++) {
    if (!paths[i]) continue;
    const item = { path: paths[i] };
    if (types[i]) item.type = types[i];
    out.push(item);
  }
  return out;
}

/**
 * Map one parsed transcript line to a chat-log entry, or null if it is not an exportable inbound
 * user message (wrong type/role, or no text AND no media). Line shape (v3):
 *   { type:'message', timestamp:'<ISO>', message:{ role:'user', content, timestamp:<epoch ms>,
 *     MediaPath(s), MediaType(s), __openclaw:{ senderIsOwner, senderId, senderName } } }
 * A caption-less media message carries a bare `<media:x>` placeholder in content — that is replaced
 * by a readable Hebrew placeholder and the (raw) media refs are attached under `media` for the caller
 * to archive.
 * @param {object} line
 * @param {object} [opts]
 * @param {string} [opts.ownerNumber]  digits that also count as the owner (default OWNER_NUMBER)
 * @returns {{ts:string, from:string, speaker:string, text:string, media?:object[]}|null}
 */
export function sessionLineToEntry(line, opts = {}) {
  const ownerNumber = opts.ownerNumber || DEFAULT_OWNER_NUMBER;
  if (!line || line.type !== 'message') return null;
  const msg = line.message;
  if (!msg || msg.role !== 'user') return null;

  const rawText = extractText(msg.content);
  const media = extractSessionMedia(msg);
  if (!rawText && media.length === 0) return null;

  const oc = (msg.__openclaw && typeof msg.__openclaw === 'object') ? msg.__openclaw : {};
  const senderDigits = digitsOnly(oc.senderId);
  const senderName = typeof oc.senderName === 'string' ? oc.senderName : '';
  const isOwner = oc.senderIsOwner === true || (senderDigits && senderDigits === ownerNumber);

  let from;
  let speaker;
  if (isOwner) {
    from = 'david';
    speaker = 'David';
  } else {
    from = senderDigits || senderName || 'unknown';
    speaker = senderName || senderDigits || 'unknown';
  }

  // ts: prefer the inner epoch-ms message.timestamp, fall back to the outer ISO string.
  let ts;
  if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
    ts = new Date(msg.timestamp).toISOString();
  } else if (typeof line.timestamp === 'string' && line.timestamp) {
    ts = line.timestamp;
  } else {
    ts = new Date().toISOString();
  }

  // A real caption wins; an empty body or a bare <media:x> placeholder becomes a Hebrew placeholder.
  const text = (rawText && !MEDIA_PLACEHOLDER_RE.test(rawText))
    ? rawText
    : (media.length ? mediaPlaceholderText(media) : rawText);

  const entry = { ts, from, speaker, text };
  if (media.length) entry.media = media; // raw refs; run() archives + rewrites to the stored shape
  return entry;
}

/**
 * Copy an entry's staged media files into the owning bot's durable archive and rewrite entry.media
 * to the stored shape [{ archivedPath (relative to workspace), mimetype, originalName, archived }].
 * Never throws; a missing/uncopyable source yields archived:false. Idempotent by construction — the
 * caller only ever processes a given transcript line once (byte-offset cursor).
 */
export function archiveEntryMedia(entry, opts = {}) {
  if (!entry || !Array.isArray(entry.media) || entry.media.length === 0) return entry;
  const mediaRoot = opts.mediaDir;
  const wsDir = opts.workspaceDir;
  const groupJid = opts.groupJid;
  const groupDir = join(mediaRoot, groupJid);
  const tsSafe = String(entry.ts || new Date().toISOString()).replace(/[:.]/g, '-');
  const archived = [];
  let idx = 0;
  for (const m of entry.media) {
    const src = m && m.path;
    const originalName = src ? basename(src) : `media-${idx}`;
    const safeName = String(originalName).replace(/[/\\\s]+/g, '_');
    let archivedPath = null;
    let ok = false;
    if (src && existsSync(src)) {
      const destAbs = join(groupDir, `${tsSafe}-listen-${idx}-${safeName}`);
      try {
        mkdirSync(groupDir, { recursive: true });
        copyFileSync(src, destAbs);
        ok = true;
        archivedPath = relative(wsDir, destAbs);
      } catch { ok = false; archivedPath = null; }
    }
    archived.push({ archivedPath, mimetype: (m && m.type) || null, originalName, archived: ok });
    idx++;
  }
  entry.media = archived;
  return entry;
}

// ---- state helpers (per-target: state/sessions/chat-log paths come from a target cfg) -------------

/** Load a target's state file; returns a well-formed default on any missing/corrupt state. */
function loadState(stateFile) {
  const empty = { offsets: {}, lastSessionFile: null };
  if (!existsSync(stateFile)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      offsets: (parsed && typeof parsed.offsets === 'object' && parsed.offsets) || {},
      lastSessionFile: (parsed && parsed.lastSessionFile) || null,
    };
  } catch {
    return empty;
  }
}

/** Atomically persist a target's state file (tmp + rename — never leaves a half-written state). */
function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, stateFile);
}

/** Resolve the current session file for a target's key, or null if unavailable. */
function currentSessionFile(sessionsJson, sessionKey) {
  if (!existsSync(sessionsJson)) return null;
  let sessions;
  try {
    sessions = JSON.parse(readFileSync(sessionsJson, 'utf8'));
  } catch {
    return null;
  }
  const rec = sessions && sessions[sessionKey];
  const file = rec && typeof rec.sessionFile === 'string' ? rec.sessionFile : null;
  if (!file || !existsSync(file)) return null;
  return file;
}

/**
 * Read new complete lines from `file` starting at `offset`. Only whole newline-terminated lines are
 * consumed (a trailing partial line is left for the next run). Returns { entries, newOffset }.
 * `ownerNumber` is threaded into the pure transform so the OWNING agent's owner is honored.
 */
function drainFile(file, offset, ownerNumber) {
  const size = statSync(file).size;
  if (size <= offset) return { entries: [], newOffset: offset };

  const buf = readFileSync(file);
  const slice = buf.subarray(offset).toString('utf8');
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl === -1) return { entries: [], newOffset: offset }; // no complete line yet

  const consumable = slice.slice(0, lastNl + 1);
  const newOffset = offset + Buffer.byteLength(consumable, 'utf8');

  const entries = [];
  for (const raw of consumable.split('\n')) {
    if (!raw) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; } // tolerate a stray malformed line
    const entry = sessionLineToEntry(obj, { ownerNumber });
    if (entry) entries.push(entry);
  }
  return { entries, newOffset };
}

// ---- main ----------------------------------------------------------------------------------------

/** Drain ONE listen-export target (owning agent + one listen group). Returns a short summary. */
function runTarget(t) {
  const state = loadState(t.stateFile);
  const current = currentSessionFile(t.sessionsJson, t.sessionKey);

  // Files to consider: everything we've seen before (to drain rotated tails) plus the current one.
  const files = new Set(Object.keys(state.offsets));
  if (current) files.add(current);
  if (files.size === 0) return `${t.agentId}/${t.groupJid}: nothing new`;

  // Older/known files first so that a rotated file's tail lands before the new file's fresh lines.
  // The current file is drained last.
  const ordered = [...files].filter((f) => f !== current);
  if (current) ordered.push(current);

  const allEntries = [];
  for (const file of ordered) {
    if (!existsSync(file)) continue; // a rotated file may have been pruned away
    const offset = Number.isFinite(state.offsets[file]) ? state.offsets[file] : 0;
    const { entries, newOffset } = drainFile(file, offset, t.ownerNumber);
    state.offsets[file] = newOffset;
    if (entries.length) allEntries.push(...entries);
  }

  if (current) state.lastSessionFile = current;

  if (allEntries.length === 0) {
    // Persist any advanced offsets (e.g. lines that were all non-user) so we don't rescan them.
    saveState(t.stateFile, state);
    return `${t.agentId}/${t.groupJid}: nothing new`;
  }

  // Archive any staged media out of the workspace's ephemeral inbound-staging into the durable
  // data/media/<group>/ store, rewriting each entry's media refs to the stored shape.
  let withMedia = 0;
  for (const e of allEntries) {
    if (e.media && e.media.length) {
      archiveEntryMedia(e, { mediaDir: t.mediaDir, workspaceDir: t.workspaceDir, groupJid: t.groupJid });
      withMedia++;
    }
  }

  mkdirSync(dirname(t.chatLog), { recursive: true });
  appendFileSync(t.chatLog, allEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  saveState(t.stateFile, state);
  const mediaNote = withMedia ? ` (${withMedia} with media)` : '';
  return `${t.agentId}/${t.groupJid}: ${allEntries.length} new message(s) appended${mediaNote}`;
}

function run() {
  const targets = buildTargets();
  if (!targets.length) {
    console.log('listen-export: no listen-only groups in the registry — nothing to do');
    return;
  }
  for (const t of targets) {
    // Isolate per-target failures so one bad group never blocks the others.
    try { console.log(`listen-export: ${runTarget(t)}`); }
    catch (e) { console.error(`listen-export: ${t.agentId}/${t.groupJid}: error: ${(e && e.message) || e}`); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    run();
    process.exit(0);
  } catch (e) {
    // Never fail the systemd unit: one line to stderr, exit 0.
    console.error(`listen-export: error: ${(e && e.message) || e}`);
    process.exit(0);
  }
}
