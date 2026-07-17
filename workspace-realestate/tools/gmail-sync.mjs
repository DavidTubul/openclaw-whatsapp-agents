#!/usr/bin/env node
// gmail-sync.mjs — Gmail → local Markdown mirror for digit.
//
// Usage:
//   node tools/gmail-sync.mjs [--dry-run] [--verbose] [--full] [--alerts]
//   node tools/gmail-sync.mjs --backfill-attachments [--verbose] [--dry-run]
//
// Read-only against Gmail: fetches with PEEK semantics only — never STORE/APPEND,
// so it does not touch \Seen flags or mutate the mailbox. Attachment bodies are
// pulled via client.download(), which fetches BODY.PEEK[<part>] (verified in
// imapflow lib/commands/fetch.js setBodyPeek — BODY.PEEK never sets \Seen). On
// first run the `1:*` fetch backfills the whole [Gmail]/All Mail; subsequent
// runs are UID-incremental (fetch from lastUid+1). Writes:
//   data/mail/messages/*.md         one Markdown file per message
//   data/mail/attachments/<uid>--<name>  downloaded document attachments
//                                   (pdf/docx/xlsx/csv only; >30MB skipped)
//   data/mail/INDEX.md              newest-first table of all mirrored mail
//   data/mail/ATTACHMENTS.md        newest-first table of downloaded documents
//                                   (rebuilt every non-dry run, like INDEX.md)
//   data/mail/state.json            { uidValidity, lastUid, lastSyncTs }
//   data/mail/pending-attention.json threads whose newest msg is inbound & new
//                                   (ONLY on --alerts runs; see alert-state.json)
//   data/mail/alert-state.json      { uidValidity, alertedUid } — the alert
//                                   high-water mark, advanced ONLY by --alerts runs
//
// --backfill-attachments: one-shot pass over ALL already-mirrored messages —
// downloads any document attachments still missing on disk and rewrites each
// message's .md with `file:` fields. Idempotent; aborts if state.json's
// uidValidity no longer matches the live mailbox (never downloads wrong content).
//
// Auth: GMAIL_USER / GMAIL_APP_PASSWORD from ~/.openclaw/secrets/gmail-digit.env.
// The env FILE is authoritative — inherited process.env is only a fallback for
// vars the file doesn't define. The gateway's systemd environment carries
// jobscout's GMAIL_USER/GMAIL_APP_PASSWORD (David's personal account); letting
// env win made cron runs mirror the personal mailbox into digit's data/mail
// (2026-07-15 incident).
//
// Exit codes: 0 ok · 2 config error (creds) · 1 sync error. Errors → JSON on stderr.

import { ImapFlow } from 'imapflow';
import { writeFileSync, mkdirSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import {
  decodeMimeBody,
  renderMessageMd,
  messageFileName,
  loadAllMessages,
  groupByThread,
  computePending,
  renderIndex,
  renderAttachmentsIndex,
  loadState,
  saveState,
  pickAllMailPath,
  computeAlertDecision,
  isDocumentAttachment,
  isAttachmentTooLarge,
  attachmentFileName,
} from './lib/mail-core.mjs';
import { loadEnvFile } from '../../shared/lib/gmail.mjs';

const WS = dirname(dirname(fileURLToPath(import.meta.url)));          // workspace root
const MAIL = join(WS, 'data', 'mail');
const args = new Set(process.argv.slice(2));
const V = args.has('--verbose');
const DRY = args.has('--dry-run');
// --alerts (cron only): also compute pending-attention.json against a separate
// alert baseline (alert-state.json). On-demand runs omit it and never touch it.
const ALERTS = args.has('--alerts');
// --backfill-attachments: one-shot pass over ALL mirrored messages (see header).
const BACKFILL = args.has('--backfill-attachments');

// Load ~/.openclaw/secrets/gmail-digit.env into process.env (FILE wins — see header + the
// shared helper's incident note). Same behavior as the former local loadEnvFile.
loadEnvFile(join(process.env.HOME, '.openclaw', 'secrets', 'gmail-digit.env'));

const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD;
if (!USER || !PASS || USER.startsWith('REPLACE')) {
  console.error(JSON.stringify({ error: 'gmail creds missing (see secrets/gmail-digit.env)' }));
  process.exit(2);
}

mkdirSync(join(MAIL, 'messages'), { recursive: true });
const statePath = join(MAIL, 'state.json');
const alertStatePath = join(MAIL, 'alert-state.json');
const ATT_DIR = join(MAIL, 'attachments');

// --- Attachment helpers (I/O + network — pure decision logic lives in mail-core) ---

// Collect attachment nodes from a bodyStructure tree. Returns the fields the
// download pass needs: name, size, part (IMAP part number, e.g. "2"/"1.2"), and
// contentType (n.type, already lowercased by imapflow — used as the
// isDocumentAttachment fallback for unnamed parts).
function walkAttachments(bodyStructure) {
  const atts = [];
  (function walk(n) {
    if (!n) return;
    if (n.disposition === 'attachment') {
      atts.push({
        name: n.dispositionParameters?.filename || n.parameters?.name || 'unnamed',
        size: n.size || 0,
        part: n.part,
        contentType: n.type || '',
      });
    }
    (n.childNodes || []).forEach(walk);
  })(bodyStructure);
  return atts;
}

// Download one bodystructure part to absPath. client.download() fetches via
// fetchOne({ bodyParts }) → BODY.PEEK[<part>] (verified: imapflow
// lib/commands/fetch.js setBodyPeek, commandKey defaults to BODY) — read-only,
// never sets \Seen. Returns true iff a nonzero file landed on disk.
async function downloadPart(uid, part, absPath) {
  const dl = await client.download(String(uid), part, { uid: true });
  if (!dl || !dl.content) return false;
  await pipeline(dl.content, createWriteStream(absPath));
  return existsSync(absPath) && statSync(absPath).size > 0;
}

// Download the document attachments of one message, mutating each entry in
// `atts` in place: sets `.file` (relative path) on success, or `.skipped`
// ("too-large" | "not-document"). Idempotent — an existing nonzero target file
// is adopted without re-downloading. Returns the count actually downloaded.
async function downloadAttachments(uid, atts, verbose) {
  let downloaded = 0;
  for (const a of atts) {
    if (!isDocumentAttachment(a.name, a.contentType)) { a.skipped = 'not-document'; continue; }
    if (isAttachmentTooLarge(a.size)) {
      a.skipped = 'too-large';
      if (verbose) console.error(`[gmail-sync]   uid ${uid}: skip "${a.name}" (>30MB: ${a.size}B)`);
      continue;
    }
    const fname = attachmentFileName(uid, a.name);
    const abs = join(ATT_DIR, fname);
    const rel = `attachments/${fname}`;
    if (existsSync(abs) && statSync(abs).size > 0) { a.file = rel; continue; } // idempotent
    if (!a.part) { if (verbose) console.error(`[gmail-sync]   uid ${uid}: no part for "${a.name}"`); continue; }
    try {
      if (await downloadPart(uid, a.part, abs)) {
        a.file = rel;
        downloaded++;
        if (verbose) console.error(`[gmail-sync]   uid ${uid}: downloaded ${rel} (${a.size}B)`);
      } else if (verbose) {
        console.error(`[gmail-sync]   uid ${uid}: empty download for "${a.name}"`);
      }
    } catch (e) {
      if (verbose) console.error(`[gmail-sync]   uid ${uid}: download failed "${a.name}": ${e?.message || e}`);
    }
  }
  return downloaded;
}

// Backfill pass: re-fetch bodyStructure for every already-mirrored message that
// might carry a document, download the missing ones, and rewrite that message's
// .md with `file:` fields. Idempotent. Caller has already verified uidValidity.
async function runBackfill(verbose) {
  const all = loadAllMessages(join(MAIL, 'messages'));
  mkdirSync(ATT_DIR, { recursive: true });
  let scanned = 0, fetched = 0, downloaded = 0, rewrote = 0;
  for (const msg of all) {
    const meta = msg.attachments || [];
    if (meta.length === 0) continue;
    scanned++;
    // Prune: only touch the server for an UNPROCESSED entry that could be a
    // document. Named non-documents (image001.jpg, .rpmsg, .ics) never qualify;
    // unnamed/empty entries do (could be an unnamed application/pdf). An entry
    // already carrying `file:` or `skipped:` was handled on a prior run, so a
    // fully-backfilled message fetches nothing — the re-run is a true no-op.
    const candidate = meta.some((a) => {
      if (a.file || a.skipped) return false; // already processed
      const nm = String(a.name || '').trim().toLowerCase();
      return isDocumentAttachment(a.name) || nm === '' || nm === 'unnamed';
    });
    if (!candidate) continue;
    fetched++;
    let one;
    try {
      one = await client.fetchOne(String(msg.uid), { uid: true, bodyStructure: true }, { uid: true });
    } catch (e) {
      if (verbose) console.error(`[gmail-sync] backfill: fetch failed uid ${msg.uid}: ${e?.message || e}`);
      continue;
    }
    if (!one || !one.bodyStructure) {
      if (verbose) console.error(`[gmail-sync] backfill: no bodyStructure for uid ${msg.uid}`);
      continue;
    }
    const walked = walkAttachments(one.bodyStructure);
    downloaded += await downloadAttachments(msg.uid, walked, verbose);
    // Re-render from the freshly-walked attachments (name/size/file/skipped);
    // the transient part/contentType fields are ignored by renderMessageMd.
    msg.attachments = walked;
    writeFileSync(join(MAIL, 'messages', msg.file), renderMessageMd(msg));
    rewrote++;
  }
  // Rebuild aggregates over ALL mirrored mail (re-parses frontmatter back).
  const all2 = loadAllMessages(join(MAIL, 'messages'));
  writeFileSync(join(MAIL, 'INDEX.md'), renderIndex(all2, USER));
  writeFileSync(join(MAIL, 'ATTACHMENTS.md'), renderAttachmentsIndex(all2));
  console.error(`[gmail-sync] backfill: ${scanned} w/attachments, ${fetched} fetched, ${downloaded} downloaded, ${rewrote} rewritten`);
}

let state = args.has('--full') ? null : loadState(statePath);
// Distinguish "no state yet" from "state present but unreadable" (corrupt/permission)
// — both fall through to a full re-mirror, but the latter is worth a note.
if (!args.has('--full') && state === null && existsSync(statePath) && V) {
  console.error('[gmail-sync] state.json unreadable → full re-mirror');
}

const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: USER, pass: PASS },
  logger: false,
});

try {
  await client.connect();
  // Gmail localizes '[Gmail]/All Mail' by UI language — locate it via SPECIAL-USE \All.
  const allMailPath = pickAllMailPath(await client.list());
  if (V) console.error(`[gmail-sync] All Mail mailbox: ${allMailPath}`);
  const lock = await client.getMailboxLock(allMailPath);
  try {
    const box = client.mailbox;
    // uidValidity is a BigInt from imapflow — persist/compare as a String.
    const uidValidity = String(box.uidValidity);

    if (BACKFILL) {
      // Guard: never download against a re-numbered mailbox — the stored uids
      // (and thus which server messages we'd fetch) would be wrong content.
      const saved = loadState(statePath);
      if (!saved || String(saved.uidValidity) !== uidValidity) {
        throw new Error(
          `backfill aborted: state.json uidValidity ${saved?.uidValidity ?? '(none)'} != live mailbox ${uidValidity} — run a normal sync first`,
        );
      }
      if (DRY) {
        console.error('[gmail-sync] dry-run backfill — nothing fetched or written.');
      } else {
        await runBackfill(V);
      }
    } else {
      if (state && state.uidValidity !== uidValidity) {
        if (V) console.error('[gmail-sync] UIDVALIDITY changed → full re-mirror');
        state = null;
      }
      const prevLastUid = state ? state.lastUid : 0;
      const startUid = prevLastUid + 1;

      const newMsgs = [];
      for await (const msg of client.fetch(
        `${startUid}:*`,
        { envelope: true, internalDate: true, uid: true, source: true, bodyStructure: true },
        { uid: true },
      )) {
        // Gmail returns the last message for an empty `n:*` range — skip stale UIDs.
        if (msg.uid <= prevLastUid) continue;
        newMsgs.push({
          uid: msg.uid,
          // X-GM-THRID surfaces as msg.threadId when the server advertises it; fall back.
          threadId: String(msg.threadId || msg.emailId || msg.uid),
          from: msg.envelope.from?.[0]?.address || '',
          fromName: msg.envelope.from?.[0]?.name || '',
          to: (msg.envelope.to || []).map((a) => a.address).join(', '),
          cc: (msg.envelope.cc || []).map((a) => a.address).join(', '),
          subject: msg.envelope.subject || '(no subject)',
          date: msg.internalDate?.toISOString() || new Date(0).toISOString(),
          // name/size/part/contentType — download pass consumes part/contentType,
          // renderMessageMd persists only name/size (+ file/skipped once downloaded).
          attachments: walkAttachments(msg.bodyStructure),
          text: decodeMimeBody(msg.source),
        });
      }

      if (V) console.error(`[gmail-sync] ${newMsgs.length} new message(s) (from uid ${startUid})`);

      if (DRY) {
        console.error('[gmail-sync] dry-run — nothing written.');
      } else {
        if (newMsgs.some((m) => (m.attachments || []).length)) mkdirSync(ATT_DIR, { recursive: true });
        for (const m of newMsgs) {
          // Download document attachments BEFORE render so frontmatter carries file:/skipped:.
          await downloadAttachments(m.uid, m.attachments, V);
          writeFileSync(join(MAIL, 'messages', messageFileName(m)), renderMessageMd(m));
        }
        // Rebuild aggregates over ALL mirrored mail (parses frontmatter back).
        const all = loadAllMessages(join(MAIL, 'messages'));
        const threads = groupByThread(all);
        writeFileSync(join(MAIL, 'INDEX.md'), renderIndex(all, USER));
        writeFileSync(join(MAIL, 'ATTACHMENTS.md'), renderAttachmentsIndex(all));
        const maxUid = newMsgs.reduce((a, m) => Math.max(a, m.uid), prevLastUid);
        saveState(statePath, { uidValidity, lastUid: maxUid, lastSyncTs: new Date().toISOString() });
        if (V) console.error(`[gmail-sync] wrote ${newMsgs.length} file(s); lastUid=${maxUid}`);

        // pending-attention.json is a cron concern only: written EXCLUSIVELY by
        // --alerts runs, against a baseline that only --alerts runs advance. This
        // keeps on-demand syncs from suppressing (or a state reset from re-spamming)
        // the WhatsApp alert.
        if (ALERTS) {
          // maxUid over ALL mirrored mail — the true current high-water mark,
          // independent of how many messages this particular run fetched.
          const currentMaxUid = all.reduce((a, m) => Math.max(a, Number(m.uid) || 0), 0);
          const alertState = loadState(alertStatePath);
          const decision = computeAlertDecision(alertState, uidValidity, currentMaxUid);
          const pendingPath = join(MAIL, 'pending-attention.json');
          if (decision.reset) {
            writeFileSync(pendingPath, JSON.stringify([], null, 2) + '\n');
            if (V) console.error('[gmail-sync] alert baseline reset — no alerts this run');
          } else {
            const pending = computePending(threads, USER, decision.baselineUid);
            writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
            if (V) console.error(`[gmail-sync] ${pending.length} pending (baseline uid ${decision.baselineUid})`);
          }
          saveState(alertStatePath, { uidValidity, alertedUid: decision.nextAlertedUid });
        }
      }
    }
  } finally {
    lock.release();
  }
} catch (e) {
  console.error(JSON.stringify({ error: String(e?.message || e) }));
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
}
