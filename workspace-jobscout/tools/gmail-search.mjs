#!/usr/bin/env node
// Gmail IMAP search tool — uses GMAIL_USER + GMAIL_APP_PASSWORD env vars
// Usage:
//   node gmail-search.mjs --days 2 [--query 'Gmail X-GM-RAW query']
//   node gmail-search.mjs --from-date 2026-03-01          # specific start date
//   node gmail-search.mjs --days 90 --limit 2000          # custom limit
//   node gmail-search.mjs --from-date 2026-03-01 --after-uid 500  # pagination
//   node gmail-search.mjs --uid 12345                     # fetch one message + decoded text body
import { ImapFlow } from 'imapflow';
import { resolvePerson } from './lib/people.mjs';
import { readJsonSafe, writeJsonAtomic } from './lib/cli.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);

const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD;
if (!USER || !PASS) {
  console.error(JSON.stringify({ error: 'GMAIL_USER or GMAIL_APP_PASSWORD env vars missing' }));
  process.exit(2);
}

// --person <id>: incremental mode — only fetch mail newer than the last seen UID.
let gmailStateFile = null;
let lastUid = null;
if (args.person && !args.uid) {
  const p = resolvePerson(String(args.person));
  if (!p) { console.error(JSON.stringify({ error: `Unknown person "${args.person}"` })); process.exit(2); }
  gmailStateFile = p.paths.gmailState;
  lastUid = readJsonSafe(gmailStateFile, {})?.last_uid ?? null;
}

// Decode a raw RFC822 message into readable plain text: walks MIME parts,
// decodes quoted-printable / base64, strips HTML. Prefers text/plain, falls
// back to the longest text/html part. Needed because subject lines lie
// (e.g. Comeet rejections read "Thank you for applying ..."), so the daily
// status sync must be able to read bodies.
function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function decodeMimeBody(rawSource) {
  const src = rawSource.toString('utf8');
  const parts = src.split(/\r?\n--[A-Za-z0-9'()+_,\-.\/:=? ]+\r?\n/);
  let plain = '', html = '';
  for (const p of parts) {
    const m = p.match(/\r?\n\r?\n/);
    if (!m) continue;
    const headers = p.slice(0, m.index).toLowerCase();
    if (!/content-type:\s*text\/(plain|html)/i.test(headers)) continue;
    let body = p.slice(m.index + m[0].length);
    if (headers.includes('quoted-printable')) body = Buffer.from(decodeQP(body), 'binary').toString('utf8');
    else if (headers.includes('base64')) { try { body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* keep raw */ } }
    if (/content-type:\s*text\/plain/i.test(headers)) { if (body.length > plain.length) plain = body; }
    else if (body.length > html.length) html = body;
  }
  let text = plain;
  if (!text.trim() && html) {
    text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&zwnj;/gi, ' ').replace(/&amp;/gi, '&').replace(/&[a-z]+;/gi, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
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
  const lock = await client.getMailboxLock('INBOX');
  try {
    const out = [];
    const limit = args.limit ? parseInt(args.limit, 10) : 2000;

    if (args.uid) {
      // 3rd arg { uid: true } makes the lookup BY UID; without it fetchOne
      // treats the value as a sequence number and returns the wrong message.
      const msg = await client.fetchOne(String(args.uid), { envelope: true, source: true, internalDate: true, uid: true }, { uid: true });
      out.push({
        uid: msg.uid,
        from: msg.envelope.from?.[0]?.address || '',
        from_name: msg.envelope.from?.[0]?.name || '',
        subject: msg.envelope.subject || '',
        date: msg.internalDate?.toISOString() || '',
        text: decodeMimeBody(msg.source).slice(0, 4000),
      });
    } else {
      let since;
      if (args['from-date']) {
        since = new Date(args['from-date']);
      } else {
        const days = parseInt(args.days || '2', 10);
        since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      }

      const searchOpts = args.query
        ? { gmailRaw: args.query }
        : { since };

      const afterUid = args['after-uid'] ? parseInt(args['after-uid'], 10) : (lastUid ?? null);
      let maxUid = lastUid || 0;

      for await (const msg of client.fetch(searchOpts, { envelope: true, internalDate: true, uid: true, bodyStructure: false, source: false })) {
        if (msg.uid > maxUid) maxUid = msg.uid;
        // pagination / incremental: skip messages with uid <= after-uid
        if (afterUid && msg.uid <= afterUid) continue;
        out.push({
          uid: msg.uid,
          from: msg.envelope.from?.[0]?.address || '',
          from_name: msg.envelope.from?.[0]?.name || '',
          subject: msg.envelope.subject || '',
          date: msg.internalDate?.toISOString() || '',
        });
        if (out.length >= limit) break;
      }

      // Persist the high-water UID so the next --person run only sees newer mail.
      if (gmailStateFile && maxUid) {
        try { writeJsonAtomic(gmailStateFile, { last_uid: maxUid, updated_at: new Date().toISOString() }); } catch { /* best-effort */ }
      }
    }
    console.log(JSON.stringify({ ok: true, count: out.length, results: out }));
  } finally {
    lock.release();
  }
  await client.logout();
} catch (e) {
  console.error(JSON.stringify({ error: e.message, code: e.code || null }));
  process.exit(1);
}
