#!/usr/bin/env node
// sheet-sync.mjs — load/repair the Google Sheet dashboard from local source-of-truth files.
//
// Ongoing, every message is mirrored LIVE to the "שיחות" tab by the chat-log-pitzi hook, and
// every case by cases.mjs. This tool is for INITIAL LOAD and REPAIR (e.g. messages that arrived
// while sheet.enabled was false, or while the webhook was briefly down).
//
// Usage:
//   node sheet-sync.mjs ping                  → GET the webhook (health check)
//   node sheet-sync.mjs backfill [--since ISO] [--limit N]   → push chat-log rows → "שיחות"
//   node sheet-sync.mjs backfill-cases         → push every case → "תיקים"
//
// NOTE: backfill APPENDS (no dedup). Run it ONCE for initial load, or use --since to push only
// newer rows. For day-to-day, the live hook keeps the Sheet current.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postWebhook } from "../../../shared/lib/sheet-webhook.mjs";
import { chatSheetRow } from "../../../shared/hooks/chat-log/agent-cfg.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const CONFIG_PATH = `${ROOT}/.config/bot.json`;
const CHATLOG_DIR = `${ROOT}/data/chat-log`;
const CASES = `${ROOT}/data/cases/cases.jsonl`;

function out(o) { console.log(JSON.stringify(o)); }
function fail(error, extra = {}) { console.log(JSON.stringify({ ok: false, error, ...extra })); process.exit(1); }

function cfg() {
  let c; try { c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch (e) { fail(`cannot read config: ${e.message}`); }
  if (!c?.sheet?.webhook_url) fail("sheet.webhook_url missing — set it in .config/bot.json (see tools/apps-script-webhook.gs)");
  return c;
}

// Shared webhook client (timeout + non-JSON tolerance); thin adapter to this tool's { parsed } shape.
async function post(url, body) {
  const r = await postWebhook(url, body);
  return { ok: r.ok, status: r.status, parsed: r.response ?? { error: r.error } };
}

function readJsonl(file) {
  let raw = ""; try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const l of raw.split("\n")) { const s = l.trim(); if (!s) continue; try { rows.push(JSON.parse(s)); } catch { /* skip */ } }
  return rows;
}

async function cmdPing() {
  const url = cfg().sheet.webhook_url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    out({ ok: res.ok, status: res.status, response: parsed });
  } catch (e) { fail(`ping failed: ${e.message}`); }
  finally { clearTimeout(timer); }
}

async function cmdBackfill(args) {
  const url = cfg().sheet.webhook_url;
  const since = argVal(args, "--since");
  const limit = Number(argVal(args, "--limit")) || Infinity;
  // gather all chat-log records across conversation files, sorted by time
  let recs = [];
  let files = []; try { files = readdirSync(CHATLOG_DIR).filter((f) => f.endsWith(".jsonl")); } catch { /* none */ }
  for (const f of files) recs.push(...readJsonl(`${CHATLOG_DIR}/${f}`));
  recs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (since) recs = recs.filter((r) => String(r.ts) >= since);
  recs = recs.slice(0, limit === Infinity ? recs.length : limit);

  let sent = 0, failed = 0;
  for (const r of recs) {
    try { const res = await post(url, { action: "append-chat", row: chatSheetRow(r) }); res.ok ? sent++ : failed++; }
    catch { failed++; }
  }
  out({ ok: failed === 0, pushed: sent, failed, total: recs.length });
}

async function cmdBackfillCases() {
  const url = cfg().sheet.webhook_url;
  const cases = readJsonl(CASES);
  let sent = 0, failed = 0;
  for (const c of cases) {
    try { const res = await post(url, { action: "append", row: c }); res.ok ? sent++ : failed++; }
    catch { failed++; }
  }
  out({ ok: failed === 0, pushed: sent, failed, total: cases.length });
}

function argVal(args, key) { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; }

const [cmd, ...rest] = process.argv.slice(2);
const run = {
  ping: cmdPing,
  backfill: () => cmdBackfill(rest),
  "backfill-cases": cmdBackfillCases,
}[cmd];
if (!run) fail(`unknown command: ${cmd || "(none)"}`, { usage: ["ping", "backfill [--since ISO] [--limit N]", "backfill-cases"] });
run().catch((e) => fail(e.message));
