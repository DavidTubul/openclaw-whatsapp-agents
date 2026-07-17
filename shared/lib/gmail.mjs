// shared/lib/gmail.mjs — Gmail/IMAP primitives shared by every bot that reads mail.
//
// Before this existed, `decodeQP` + `decodeMimeBody` were byte-identical copies in
// workspace-realestate/tools/lib/mail-core.mjs and workspace-jobscout/tools/gmail-search.mjs
// (each carrying a "copied from the other workspace — workspaces stay isolated" note). The
// credential-precedence rule (env-FILE beats inherited process.env) was likewise a realestate
// one-off. This module is the single home for all three. Each bot keeps its OWN ImapFlow
// orchestration — only the duplicated pure primitives + the credential loader live here.

import { readFileSync } from "node:fs";

// --- MIME decoding -------------------------------------------------------

/** Decode a quoted-printable string (soft line-breaks + =HH hex escapes). */
export function decodeQP(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Decode a raw RFC822 message into readable plain text: walks MIME parts, decodes
 * quoted-printable / base64, strips HTML. Prefers text/plain, falls back to the longest
 * text/html part. Needed because subject lines lie (e.g. Comeet rejections read "Thank you
 * for applying…"), so a status sync must read bodies.
 * @param {Buffer|string} rawSource
 * @returns {string}
 */
export function decodeMimeBody(rawSource) {
  const src = rawSource.toString("utf8");
  const parts = src.split(/\r?\n--[A-Za-z0-9'()+_,\-.\/:=? ]+\r?\n/);
  let plain = "", html = "";
  for (const p of parts) {
    const m = p.match(/\r?\n\r?\n/);
    if (!m) continue;
    const headers = p.slice(0, m.index).toLowerCase();
    if (!/content-type:\s*text\/(plain|html)/i.test(headers)) continue;
    let body = p.slice(m.index + m[0].length);
    if (headers.includes("quoted-printable")) body = Buffer.from(decodeQP(body), "binary").toString("utf8");
    else if (headers.includes("base64")) { try { body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { /* keep raw */ } }
    if (/content-type:\s*text\/plain/i.test(headers)) { if (body.length > plain.length) plain = body; }
    else if (body.length > html.length) html = body;
  }
  let text = plain;
  if (!text.trim() && html) {
    text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&zwnj;/gi, " ").replace(/&amp;/gi, "&").replace(/&[a-z]+;/gi, " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

// --- Credential loading --------------------------------------------------

/**
 * Parse a minimal `.env` (KEY=VALUE per line) into an object. Keys are UPPER_SNAKE; the value
 * is captured verbatim to end-of-line, so spaces (Gmail app passwords display as 4 groups) and
 * '=' signs survive. Blank, commented, and malformed lines are skipped.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Load a secrets env-file into process.env with EXPLICIT precedence: the FILE is authoritative —
 * each key it defines OVERWRITES the inherited process.env value; keys absent from the file keep
 * their inherited value (fallback). A missing/unreadable file is a no-op (rely on real env).
 *
 * Why the file must win (2026-07-15 incident, ported from workspace-realestate/tools/gmail-sync.mjs):
 * the gateway's systemd environment carries jobscout's GMAIL_USER/GMAIL_APP_PASSWORD (David's
 * personal account). digit's gmail-sync loads ~/.openclaw/secrets/gmail-digit.env; when inherited
 * env was allowed to win, cron runs mirrored the PERSONAL mailbox into digit's data/mail. File-wins
 * precedence is what keeps each bot pinned to its own account.
 *
 * @param {string} path  absolute path to the env-file (parameterized per bot)
 * @returns {object}     the parsed key/values that were applied (empty object when absent)
 */
export function loadEnvFile(path) {
  try {
    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(parsed)) process.env[k] = v;
    return parsed;
  } catch {
    return {}; // file absent → rely on real env
  }
}
