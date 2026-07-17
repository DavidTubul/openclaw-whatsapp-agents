#!/usr/bin/env node
// Job Scout — Google Sheet webhook CLI wrapper
// Thin CLI around the "Job Search Tracker" Apps Script Web App.
// Usage:
//   node sheet.mjs ping
//   node sheet.mjs append '<row-or-array-JSON>'
//   node sheet.mjs read [statusFilter]
//   node sheet.mjs update <row> '<updatesJSON>'
//   node sheet.mjs update-by-id <id> '<updatesJSON>'   (robust: locate→update→read-back)
//   node sheet.mjs find <id>
//   node sheet.mjs ids
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { failJson as fail } from './lib/cli.mjs';
import { requestWebhook } from '../../shared/lib/sheet-webhook.mjs';
import { hasHttpScheme } from './lib/verify-links.mjs';

// Hard guard: a provided, non-empty `url` field MUST be an http(s):// URL, so garbage text
// (a page title, a stray note) can never land in the url column again. Empty string stays
// allowed — some gmail-backfill rows legitimately have no URL. Fails with the standard
// {ok:false,error} shape via fail(). Checks every object given (append rows / update updates).
function assertUrlFields(objs) {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    if (!('url' in o)) continue;
    const v = o.url;
    if (v === '' || v == null) continue; // empty is allowed
    if (typeof v !== 'string' || !hasHttpScheme(v)) fail(`invalid url: ${String(v)}`);
  }
}

// Derive workspace root from this module's location (tools/sheet.mjs → ../).
// Robust against the workspace dir being renamed (was hardcoded to /open_claw/workspace).
const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.config', 'job-scout.json');
const TIMEOUT_MS = 30000;

function getWebhookUrl() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    fail(`could not read config at ${CONFIG_PATH}: ${e.message}`);
  }
  const url = cfg?.google?.sheet_webhook_url;
  if (!url) fail('sheet_webhook_url missing from config (.google.sheet_webhook_url)');
  return url;
}

// Perform a request to the webhook and parse the JSON response.
// The webhook returns a 302 to script.googleusercontent.com; fetch with
// redirect:'follow' re-issues as GET automatically (we must NOT force method) —
// shared requestWebhook GETs when bodyObj is undefined (ping/read-back), POSTs otherwise.
// The retry policy (3× exp backoff on 5xx/network, timeout terminal) now lives in the
// shared client (requestWebhook), which merely returns the raw response text; the exact
// jobscout response semantics (JSON.parse, non-JSON fail with a 120-char preview + status,
// distinct timeout vs fetch-failed messages) are preserved here.
async function callWebhook(url, bodyObj) {
  const r = await requestWebhook(url, bodyObj, { timeoutMs: TIMEOUT_MS, retry: true });
  if (r.error) {
    if (r.timeout) fail(`request timed out after ${TIMEOUT_MS}ms`); // terminal — don't stack timeouts
    fail(`fetch failed: ${r.error}`);
  }
  try {
    return JSON.parse(r.text);
  } catch {
    fail(`webhook returned non-JSON (HTTP ${r.status})`, { preview: r.text.slice(0, 120) });
  }
}

function parseJsonArg(arg, label) {
  if (arg === undefined) fail(`missing ${label} argument`);
  try {
    return JSON.parse(arg);
  } catch (e) {
    fail(`invalid JSON for ${label}: ${e.message}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const url = getWebhookUrl();

  switch (cmd) {
    case 'ping': {
      const out = await callWebhook(url); // GET
      console.log(JSON.stringify(out));
      break;
    }
    case 'append': {
      const parsed = parseJsonArg(rest[0], 'row JSON');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      assertUrlFields(rows);
      const out = await callWebhook(url, { action: 'append', rows });
      console.log(JSON.stringify(out));
      break;
    }
    case 'read': {
      const body = { action: 'read' };
      if (rest[0] !== undefined) body.filter = { status: rest[0] };
      const out = await callWebhook(url, body);
      console.log(JSON.stringify(out));
      break;
    }
    case 'update': {
      const row = Number(rest[0]);
      if (!Number.isFinite(row) || row < 2) fail('update requires a valid row number (>= 2)');
      const updates = parseJsonArg(rest[1], 'updates JSON');
      assertUrlFields([updates]);
      const out = await callWebhook(url, { action: 'update', row, updates });
      console.log(JSON.stringify(out));
      break;
    }
    case 'update-by-id': {
      // Robust update that does NOT depend on a (volatile) row number.
      // The sheet auto-re-sorts on every status change/append, so a row index
      // the user saw a moment ago may now point at a different job. Address by
      // the stable id (col A) instead: locate → update → read the row back.
      const id = rest[0];
      if (id === undefined || id === '') fail('update-by-id requires an id argument');
      const updates = parseJsonArg(rest[1], 'updates JSON');
      assertUrlFields([updates]);
      const before = await callWebhook(url, { action: 'read', filter: { id } });
      if (!before.ok) { console.log(JSON.stringify(before)); process.exit(1); }
      const matches = before.rows || [];
      if (matches.length === 0) fail(`no row found with id ${id}`, { id });
      if (matches.length > 1) fail(`ambiguous: ${matches.length} rows share id ${id}`, { id, rows: matches });
      const located_row = matches[0].sheet_row;
      const upd = await callWebhook(url, { action: 'update', row: located_row, updates });
      if (!upd.ok) { console.log(JSON.stringify(upd)); process.exit(1); }
      // Re-read by id (row may have moved if status changed → re-sort).
      const after = await callWebhook(url, { action: 'read', filter: { id } });
      const row_after = (after.ok && (after.rows || [])[0]) || null;
      console.log(JSON.stringify({ ok: true, id, located_row, updated: upd.updated, row_after }));
      break;
    }
    case 'find': {
      const id = rest[0];
      if (id === undefined) fail('find requires an id argument');
      const out = await callWebhook(url, { action: 'find_by_id', id });
      console.log(JSON.stringify(out));
      break;
    }
    case 'ids': {
      const out = await callWebhook(url, { action: 'read' });
      if (!out.ok) {
        console.log(JSON.stringify(out));
        process.exit(1);
      }
      const ids = (out.rows || []).map((r) => r.id).filter((v) => v !== '' && v != null);
      console.log(JSON.stringify(ids));
      break;
    }
    case 'sort': {
      const out = await callWebhook(url, { action: 'sort' });
      console.log(JSON.stringify(out));
      break;
    }
    default:
      fail(`unknown command: ${cmd ?? '(none)'} — use ping|append|read|update|update-by-id|find|ids|sort`);
  }
}

main();
