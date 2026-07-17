#!/usr/bin/env node
// shared/tools/transcribe-media.mjs — Hebrew voice-note transcription for archived group media.
//
// GOAL: voice notes sent in any group a bot serves must have their SPOKEN content enter memory. The
// chat-log hook (+ listen-export) already archive inbound media into each bot's
//   <workspace>/data/media/<groupJid>/<file>
// but audio files are opaque to the text pipeline. This tool scans every bot's data/media/ for audio
// files that have no sibling `<file>.transcript.txt`, transcribes each (Hebrew) via a PLUGGABLE
// backend, writes the transcript next to the file, and APPENDS a chat-log entry
//   { ts, from:"system", speaker:"תמלול", type:"transcript", refMessageId, text }
// to the group's data/chat-log/<groupJid>.jsonl — so the daily reflect step distils the speech into
// group-notes.md just like any other message.
//
// WHY NOT IN THE HOOK: transcription is slow (model load + decode) and would block message
// processing / violate the never-throw hook contract. It runs out-of-band from a systemd user timer
// (openclaw-transcribe.timer), after listen-export.
//
// BACKEND (pluggable): default spawns `python3 shared/tools/transcribe-fw.py <file>` (faster-whisper).
// Override the whole command with env TRANSCRIBE_CMD (a shell command; the file path is appended as
// the last arg). A backend that reports "unavailable" (exit 3) leaves the file QUEUED (retried next
// run once the backend is installed) and stops the run early — it NEVER fakes a transcript. A
// per-file error (exit 1) drops a `<file>.transcript.err` marker so a genuinely-bad file isn't retried
// forever.
//
// SAFETY: like the other timers, it catches everything and exits 0 so the unit never spams failures.
//
// Usage:
//   node shared/tools/transcribe-media.mjs            # scan all bots, transcribe the queue
//   node shared/tools/transcribe-media.mjs --dry-run  # print the queue, do not transcribe
//   node shared/tools/transcribe-media.mjs --agent <id>
import {
  readdirSync, existsSync, statSync, writeFileSync, appendFileSync, mkdirSync,
} from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listAgents, getAgent } from '../lib/agent-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FW_SCRIPT = join(__dirname, 'transcribe-fw.py');

// Audio extensions worth transcribing (WhatsApp voice notes are opus/ogg; others for completeness).
export const AUDIO_EXTS = new Set([
  'ogg', 'oga', 'opus', 'm4a', 'mp3', 'wav', 'aac', 'amr', 'flac',
]);

/** True when a filename looks like a transcribable audio file (and not a transcript sidecar). */
export function isAudioFile(name) {
  if (!name || name.endsWith('.transcript.txt') || name.endsWith('.transcript.err')) return false;
  const ext = extname(name).replace('.', '').toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/** Sidecar paths for a given audio file. */
export function transcriptPathFor(file) { return `${file}.transcript.txt`; }
export function errorPathFor(file) { return `${file}.transcript.err`; }

/** Does this audio file still need transcription? (no .transcript.txt and no .transcript.err) */
export function needsTranscription(file) {
  return !existsSync(transcriptPathFor(file)) && !existsSync(errorPathFor(file));
}

/**
 * Scan one workspace's data/media/ tree and return the pending audio queue.
 * Shape: [{ file, groupJid, jsonlPath, workspaceDir }].
 */
export function scanWorkspace(workspaceDir) {
  const out = [];
  const mediaRoot = join(workspaceDir, 'data', 'media');
  if (!existsSync(mediaRoot)) return out;
  let groups;
  try { groups = readdirSync(mediaRoot, { withFileTypes: true }); } catch { return out; }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupJid = g.name;
    const groupDir = join(mediaRoot, groupJid);
    let files;
    try { files = readdirSync(groupDir); } catch { continue; }
    for (const name of files) {
      if (!isAudioFile(name)) continue;
      const file = join(groupDir, name);
      if (!needsTranscription(file)) continue;
      out.push({
        file,
        groupJid,
        workspaceDir,
        jsonlPath: join(workspaceDir, 'data', 'chat-log', `${groupJid}.jsonl`),
      });
    }
  }
  return out;
}

/** Scan every registered agent (or one). Returns the combined pending queue. */
export function scanAll(agents) {
  const out = [];
  const seen = new Set();
  for (const a of agents) {
    if (!a || !a.workspaceDir || seen.has(a.workspaceDir)) continue;
    seen.add(a.workspaceDir);
    out.push(...scanWorkspace(a.workspaceDir));
  }
  return out;
}

/**
 * Default backend: spawn faster-whisper (or TRANSCRIBE_CMD). Returns:
 *   { ok:true, text }                     -> transcript produced
 *   { ok:false, unavailable:true, error } -> backend not installed / model unloadable (retry later)
 *   { ok:false, error }                   -> per-file failure (mark .err)
 */
export function defaultBackend(file) {
  const custom = process.env.TRANSCRIBE_CMD;
  let res;
  if (custom) {
    res = spawnSync('/bin/sh', ['-c', `${custom} "$1"`, 'sh', file], {
      encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
  } else {
    const py = process.env.PYTHON_BIN || 'python3';
    res = spawnSync(py, [FW_SCRIPT, file], {
      encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
  }
  if (res.error) {
    // ENOENT etc. — treat as backend unavailable so we retry rather than mark the file bad.
    return { ok: false, unavailable: true, error: String(res.error.message || res.error) };
  }
  if (res.status === 3) return { ok: false, unavailable: true, error: (res.stderr || '').trim() };
  if (res.status !== 0) return { ok: false, error: (res.stderr || `exit ${res.status}`).trim() };
  return { ok: true, text: (res.stdout || '').trim() };
}

/**
 * Transcribe one queue item: run the backend, write the sidecar, append the chat-log transcript
 * entry. Returns a small result record. `backend` is injectable for tests.
 */
export function transcribeOne(item, backend = defaultBackend) {
  const r = backend(item.file);
  if (!r.ok) {
    if (r.unavailable) return { file: item.file, ok: false, unavailable: true, error: r.error };
    // per-file failure — drop an .err marker so we don't spin on a bad file every run.
    try { writeFileSync(errorPathFor(item.file), `${new Date().toISOString()} ${r.error || ''}\n`); } catch { /* ignore */ }
    return { file: item.file, ok: false, error: r.error };
  }

  const text = (r.text || '').trim();
  // Write the sidecar even when empty (a genuinely silent clip) so we don't retry forever.
  try { writeFileSync(transcriptPathFor(item.file), text + '\n'); } catch { /* best-effort */ }

  if (text) {
    const entry = {
      ts: mtimeIso(item.file),
      from: 'system',
      speaker: 'תמלול',
      type: 'transcript',
      refMessageId: basename(item.file),
      text: `🎙️ תמלול הקלטה קולית: ${text}`,
    };
    try {
      mkdirSync(dirname(item.jsonlPath), { recursive: true });
      appendFileSync(item.jsonlPath, JSON.stringify(entry) + '\n');
    } catch { /* best-effort */ }
  }
  return { file: item.file, ok: true, empty: !text, chars: text.length };
}

/** ISO timestamp from a file's mtime (keeps the transcript chronological in the log). */
function mtimeIso(file) {
  try { return statSync(file).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

// ---- main ----------------------------------------------------------------------------------------

function run() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const agentFlag = (() => { const i = argv.indexOf('--agent'); return i !== -1 ? argv[i + 1] : null; })();

  const agents = agentFlag
    ? [getAgent(agentFlag)].filter(Boolean)
    : listAgents();
  const queue = scanAll(agents);

  if (queue.length === 0) { console.log('transcribe-media: nothing to transcribe'); return; }
  if (dryRun) {
    console.log(`transcribe-media: ${queue.length} pending`);
    for (const q of queue) console.log(`  ${q.groupJid}  ${basename(q.file)}`);
    return;
  }

  let done = 0, empty = 0, failed = 0;
  for (const item of queue) {
    const r = transcribeOne(item);
    if (r.unavailable) {
      // Backend not ready — stop; the rest stays queued for the next run.
      console.error(`transcribe-media: backend unavailable, ${queue.length - done} left queued: ${r.error}`);
      break;
    }
    if (r.ok) { done++; if (r.empty) empty++; }
    else { failed++; console.error(`transcribe-media: failed ${basename(item.file)}: ${r.error}`); }
  }
  console.log(`transcribe-media: transcribed ${done} (${empty} empty), ${failed} failed, ${queue.length} scanned`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { run(); process.exit(0); }
  catch (e) { console.error(`transcribe-media: error: ${(e && e.message) || e}`); process.exit(0); }
}
