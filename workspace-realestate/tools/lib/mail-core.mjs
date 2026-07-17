// mail-core.mjs — pure logic for the Gmail→local-Markdown mirror (digit).
//
// No network and no fs except loadState/saveState/loadAllMessages, which touch
// disk defensively (try/catch). Everything else is a pure function so the IMAP
// CLI (Task 3) can compose it and the unit tests can exercise it without I/O.

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { writeFileAtomic } from "../../../shared/lib/fs-atomic.mjs";

// --- MIME decoding -------------------------------------------------------
// decodeMimeBody/decodeQP were duplicated byte-for-byte here and in jobscout's gmail-search.mjs;
// they now live in shared/lib/gmail.mjs. Re-exported so gmail-sync.mjs keeps importing it from here.
export { decodeMimeBody } from "../../../shared/lib/gmail.mjs";

// --- Markdown message render/parse --------------------------------------

// Quote a scalar as a YAML double-quoted string, escaping `\` then `"`.
function q(s) {
  return '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Reverse of q(): strip surrounding quotes and unescape; pass through bare scalars.
function unq(s) {
  if (s == null) return "";
  s = String(s);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    let out = "", esc = false;
    for (const ch of inner) {
      if (esc) { out += ch; esc = false; }
      else if (ch === "\\") esc = true;
      else out += ch;
    }
    return out;
  }
  return s;
}

export function renderMessageMd(m) {
  const fm = [
    "---",
    `uid: ${Number(m.uid)}`,
    `thread: ${q(m.threadId)}`,
    `from: ${q(m.from)}`,
    `to: ${q(m.to)}`,
    `cc: ${q(m.cc)}`,
    `subject: ${q(m.subject)}`,
    `date: ${q(m.date)}`,
  ];
  const atts = m.attachments || [];
  if (atts.length === 0) {
    fm.push("attachments: []");
  } else {
    fm.push("attachments:");
    for (const a of atts) {
      fm.push(`  - name: ${q(a.name)}`);
      fm.push(`    size: ${Number(a.size) || 0}`);
      // Optional, backward-compatible: `file` (relative path once downloaded)
      // or `skipped` ("too-large" | "not-document"). Legacy entries have neither.
      if (a.file) fm.push(`    file: ${q(a.file)}`);
      if (a.skipped) fm.push(`    skipped: ${q(a.skipped)}`);
    }
  }
  fm.push("---", "");
  return fm.join("\n") + "\n" + (m.text ?? "") + "\n";
}

export function messageFileName(m) {
  const date = String(m.date || "").slice(0, 10); // YYYY-MM-DD
  return `${date}--${m.uid}.md`;
}

// Parse a single rendered message file back into a message object.
function parseMessageMd(content, file) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) return null;
  const body = content.slice(fmMatch[0].length).replace(/^\r?\n/, "").replace(/\s+$/, "");
  const data = { attachments: [] };
  let inAtt = false, cur = null;
  for (const line of fmMatch[1].split(/\r?\n/)) {
    if (/^attachments:\s*\[\]\s*$/.test(line)) { data.attachments = []; inAtt = false; continue; }
    if (/^attachments:\s*$/.test(line)) { data.attachments = []; inAtt = true; continue; }
    if (inAtt && /^\s+-\s*name:\s*/.test(line)) {
      cur = { name: unq(line.replace(/^\s+-\s*name:\s*/, "")), size: 0 };
      data.attachments.push(cur);
      continue;
    }
    if (inAtt && /^\s+size:\s*/.test(line)) {
      if (cur) cur.size = Number(line.replace(/^\s+size:\s*/, "")) || 0;
      continue;
    }
    // Optional, added later — absent on the 563 legacy files (name+size only).
    if (inAtt && /^\s+file:\s*/.test(line)) {
      if (cur) cur.file = unq(line.replace(/^\s+file:\s*/, ""));
      continue;
    }
    if (inAtt && /^\s+skipped:\s*/.test(line)) {
      if (cur) cur.skipped = unq(line.replace(/^\s+skipped:\s*/, ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z]+):\s?(.*)$/);
    if (kv) { inAtt = false; data[kv[1]] = kv[2]; }
  }
  return {
    uid: Number(unq(data.uid)),
    threadId: unq(data.thread),
    from: unq(data.from),
    to: unq(data.to),
    cc: unq(data.cc),
    subject: unq(data.subject),
    date: unq(data.date),
    attachments: data.attachments,
    text: body,
    file,
  };
}

// --- Aggregation ---------------------------------------------------------

export function groupByThread(messages) {
  const map = new Map();
  for (const m of messages) {
    if (!map.has(m.threadId)) map.set(m.threadId, []);
    map.get(m.threadId).push(m);
  }
  return map;
}

// Newest-by-date message of a non-empty list (last wins on ties).
function newestByDate(msgs) {
  return msgs.reduce((a, b) => (new Date(b.date) >= new Date(a.date) ? b : a));
}

// A thread is pending when its newest message is inbound (from !== accountEmail)
// AND newer than prevLastUid (alert-once). Returns newest-first.
export function computePending(threads, accountEmail, prevLastUid) {
  const acc = String(accountEmail || "").toLowerCase();
  const prev = Number(prevLastUid) || 0;
  const out = [];
  for (const msgs of threads.values()) {
    if (!msgs || msgs.length === 0) continue;
    const newest = newestByDate(msgs);
    if (String(newest.from || "").toLowerCase() === acc) continue; // ended outbound
    if (!(Number(newest.uid) > prev)) continue; // already alerted
    // Prefix with the messages/ subdir so the path matches what every prompt references
    // (data/mail/messages/…) — newest.file is a bare basename from loadAllMessages.
    out.push({ file: `messages/${newest.file}`, from: newest.from, subject: newest.subject, date: newest.date });
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  return out;
}

// --- Alert baseline decision (cron-only) ---------------------------------
//
// The WhatsApp "pending attention" alert must fire on mail newer than the
// PREVIOUS ALERT run — not the previous sync. On-demand syncs advance
// state.lastUid but must never move the alert baseline, so alert runs track
// their own high-water mark in alert-state.json { uidValidity, alertedUid }.
//
// Given the loaded alertState (or null when the file is missing), the current
// mailbox uidValidity, and maxUid (the highest currently-mirrored uid), decide:
//   • reset: true  — no prior/matching baseline (first-ever alert run, or a
//     UIDVALIDITY change / lost state). Write pending=[] and adopt maxUid as the
//     baseline so the historical backlog is NOT spammed to the group.
//   • reset: false — normal path. Alert on threads newer than baselineUid
//     (the stored alertedUid), then advance the baseline to maxUid.
// Pure — safe to unit-test.
export function computeAlertDecision(alertState, uidValidity, maxUid) {
  const next = Number(maxUid) || 0;
  if (!alertState || String(alertState.uidValidity) !== String(uidValidity)) {
    return { reset: true, nextAlertedUid: next };
  }
  return { reset: false, baselineUid: Number(alertState.alertedUid) || 0, nextAlertedUid: next };
}

// Escape a markdown table cell (pipes break the table; collapse newlines).
function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderIndex(messages, accountEmail) {
  const acc = String(accountEmail || "").toLowerCase();
  const newest = new Map(); // threadId → newest message
  for (const m of messages) {
    const cur = newest.get(m.threadId);
    if (!cur || new Date(m.date) >= new Date(cur.date)) newest.set(m.threadId, m);
  }
  const sorted = [...messages].sort((a, b) => new Date(b.date) - new Date(a.date));
  const rows = sorted.map((m) => {
    const threadNewest = newest.get(m.threadId);
    const replied = String(m.from || "").toLowerCase() === acc
      || String(threadNewest?.from || "").toLowerCase() === acc;
    return `| ${String(m.date).slice(0, 10)} | ${cell(m.from)} | ${cell(m.subject)} | ${replied ? "✓" : "✗"} | messages/${m.file} |`;
  });
  const header = "| Date | From | Subject | Replied | File |\n| --- | --- | --- | --- | --- |";
  return [header, ...rows].join("\n") + "\n";
}

// --- Attachment classification / naming ----------------------------------
//
// Only "document" attachments are mirrored to data/mail/attachments/. Decision
// logic lives here (pure) so gmail-sync.mjs just composes it and tests can
// exercise every branch without IMAP or fs.

// Documents we download. Case-insensitive; matched against the LAST extension
// (so foo.docx.pdf is treated as a pdf).
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "xlsx", "csv"]);

// Attachments larger than this are recorded but never downloaded.
export const ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024; // 30 MB

// Lowercase file extension (no dot) of a filename, or "" when there is none.
// Path components are stripped first so "a/b/c.PDF" → "pdf".
export function attachmentExtension(name) {
  const base = String(name || "").trim().split(/[/\\]/).pop();
  const m = base.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

// True when an attachment is a document we mirror. Primary signal is the file
// extension in {pdf,docx,xlsx,csv}. When the filename is missing/unnamed (no
// usable name), fall back to a content-type of application/pdf. A present name
// with a non-document extension (image001.jpg, invite.ics, message.rpmsg) is
// rejected outright and never consults the content-type. Pure — unit-tested.
export function isDocumentAttachment(name, contentType) {
  const ext = attachmentExtension(name);
  if (ext) return DOCUMENT_EXTENSIONS.has(ext);
  const nm = String(name || "").trim().toLowerCase();
  const nameMissing = nm === "" || nm === "unnamed";
  if (!nameMissing) return false; // named-but-extensionless → not a document
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  return ct === "application/pdf";
}

// True when an attachment exceeds the download size cap. Pure — unit-tested.
export function isAttachmentTooLarge(size) {
  return (Number(size) || 0) > ATTACHMENT_MAX_BYTES;
}

// Sanitize an attachment filename for safe on-disk use: take the basename only
// (defeats path traversal), drop control chars, collapse whitespace, strip
// leading dots (no dotfiles / "." / ".."), and cap ~120 chars preserving the
// extension. Hebrew/Unicode letters are preserved. Pure — unit-tested.
export function sanitizeAttachmentName(name) {
  let s = String(name || "").split(/[/\\]/).pop(); // basename → kills ../ traversal
  s = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, "").trim();
  if (!s) s = "unnamed";
  const MAX = 120;
  if (s.length > MAX) {
    const dot = s.lastIndexOf(".");
    if (dot > 0 && s.length - dot <= 12) {
      const ext = s.slice(dot);
      s = s.slice(0, Math.max(1, MAX - ext.length)) + ext;
    } else {
      s = s.slice(0, MAX);
    }
  }
  return s;
}

// On-disk filename for an attachment: "<uid>--<sanitized-name>". Pure.
export function attachmentFileName(uid, name) {
  return `${Number(uid)}--${sanitizeAttachmentName(name)}`;
}

// Render ATTACHMENTS.md: newest-first table, one row per DOWNLOADED document
// file plus a row per too-large skip. Non-documents produce no row. Pipes are
// escaped like renderIndex. Pure — unit-tested.
export function renderAttachmentsIndex(messages) {
  const rows = [];
  for (const m of messages || []) {
    for (const a of m.attachments || []) {
      let fileCell;
      if (a.file) fileCell = a.file; // downloaded → relative attachments/… path
      else if (a.skipped === "too-large") fileCell = `${a.name} (skipped >30MB)`;
      else continue; // not-document / not-downloaded → no row
      rows.push({ date: m.date, from: m.from, subject: m.subject, file: fileCell });
    }
  }
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  const note = "_Documents only (pdf/docx/xlsx/csv); attachments over 30MB are skipped (not downloaded)._";
  const header = "| Date | From | Subject | File |\n| --- | --- | --- | --- |";
  const body = rows.map(
    (r) => `| ${String(r.date).slice(0, 10)} | ${cell(r.from)} | ${cell(r.subject)} | ${cell(r.file)} |`,
  );
  return [note, "", header, ...body].join("\n") + "\n";
}

// --- Env-file parsing ----------------------------------------------------
// parseEnvFile moved to shared/lib/gmail.mjs (alongside the file-wins loadEnvFile credential
// helper). Re-exported so gmail-sync.mjs and this module's tests keep importing it from here.
export { parseEnvFile } from "../../../shared/lib/gmail.mjs";

// --- Mailbox selection ----------------------------------------------------

// Pick the All Mail mailbox from an IMAP LIST result (imapflow client.list()
// entries: { path, specialUse?, ... }). Gmail localizes '[Gmail]/All Mail' by
// account UI language, but always advertises SPECIAL-USE \All — prefer that;
// fall back to the English literal. Pure — safe to unit-test.
export function pickAllMailPath(listing) {
  for (const box of listing || []) {
    if (box && box.specialUse === "\\All") return box.path;
  }
  return "[Gmail]/All Mail";
}

// --- Disk-touching helpers ----------------------------------------------

export function loadAllMessages(messagesDir) {
  let entries = [];
  try { entries = readdirSync(messagesDir); } catch { return []; }
  const out = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    let content;
    try { content = readFileSync(join(messagesDir, name), "utf8"); } catch { continue; }
    const msg = parseMessageMd(content, basename(name));
    if (msg) out.push(msg);
  }
  return out;
}

export function loadState(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; } // missing or corrupt
}

export function saveState(path, state) {
  // Atomic: this is the Gmail-sync UID checkpoint (state.json / alert-state.json) — the ONLY
  // record of how far the mirror has read. A truncated write would re-mirror or misfire alerts.
  // Same content/format as before (pretty=2 + trailing newline).
  writeFileAtomic(path, JSON.stringify(state ?? {}, null, 2) + "\n");
}
