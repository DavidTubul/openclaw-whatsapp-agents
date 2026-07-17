#!/usr/bin/env node
// cases.mjs — service-case / complaint ledger for חנות הפיצוחים (פיצי).
//
// Source of truth (MVP): data/cases/cases.jsonl (append-only, one JSON object per line).
// A human can open it, or `export-csv` it into Sheets/Excel to review & verify.
// If bot.json sheet.enabled=true, append/update also POST to a Google Apps Script
// webhook (same pattern as Scotty's sheet.mjs) so cases land in a live Google Sheet.
//
// Usage:
//   node cases.mjs append '<caseJSON>'            → add a case (auto id + created ts) → prints the stored row
//   node cases.mjs list [status]                  → list cases (optionally filter by status), newest first
//   node cases.mjs read <id>                      → one case
//   node cases.mjs update <id> '<updatesJSON>'    → patch fields on a case (+ updated ts)
//   node cases.mjs claims <phone>                 → count freshness claims from a phone within period_days (anti-abuse)
//   node cases.mjs stats                          → quick counts by status / type
//   node cases.mjs export-csv [outfile]           → write a CSV (default data/cases/cases.csv) for a human to review
//
// All output is JSON on stdout (so the agent can parse), except export-csv (writes a file).

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonl, writeJsonl } from "../../../shared/lib/jsonl.mjs";
import { pushToSheet as pushToSheetShared } from "../../../shared/lib/sheet-webhook.mjs";
import { todayInTz } from "../../../shared/lib/time.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
// PITZI_CONFIG_PATH lets tests point at a non-existent file so the sheet mirror short-circuits —
// the same isolation zorro gained after test fixtures leaked into a LIVE Google Sheet (2026-06-29).
const CONFIG_PATH = process.env.PITZI_CONFIG_PATH || `${ROOT}/.config/bot.json`;
const LEDGER = `${ROOT}/data/cases/cases.jsonl`;

// Ordered field set → also the CSV/Sheet column order.
const FIELDS = [
  "id", "created", "updated", "status", "type",
  "customer_name", "customer_phone", "product", "complaint",
  "expiry_read", "days_to_expiry", "authentic", "decision_reason",
  "packages", "shipping", "media", "notes",
];

function out(obj) { console.log(JSON.stringify(obj)); }
function fail(error, extra = {}) { console.log(JSON.stringify({ ok: false, error, ...extra })); process.exit(1); }

function cfg() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch (e) { fail(`cannot read config: ${e.message}`); }
}
function nowIso() { return new Date().toISOString(); }
// tz-aware (Asia/Jerusalem): a naive UTC date is off-by-one during the 00:00–03:00 Israel window.
function today() { return todayInTz(); }

function genId(c) {
  const basis = `${c.customer_phone || ""}|${c.product || ""}|${c.created || nowIso()}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 12);
}

function readAll() {
  return readJsonl(LEDGER); // shared JSONL reader (skips blank/corrupt lines)
}

// Rewrite the whole ledger (used by update). Atomic — the ledger is the only source of truth.
function writeAll(rows) {
  writeJsonl(LEDGER, rows);
}

function normalize(c) {
  const row = {};
  for (const f of FIELDS) row[f] = c[f] ?? null;
  return row;
}

// ---- optional Google Sheet mirror (shared client: timeout + enabled-gate) ----------
async function pushToSheet(action, row) {
  return pushToSheetShared(cfg()?.sheet, action, row);
}

// ---- commands ----------------------------------------------------------------------
async function cmdAppend(json) {
  let c;
  try { c = JSON.parse(json); } catch (e) { fail(`bad case JSON: ${e.message}`); }
  c.created = c.created || nowIso();
  c.updated = c.created;
  c.id = c.id || genId(c);
  c.status = c.status || "ממתין לבדיקת אדם";
  c.type = c.type || "freshness";
  const row = normalize(c);
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  const sheet = await pushToSheet("append", row);
  out({ ok: true, id: row.id, row, sheet });
}

function cmdList(status) {
  let rows = readAll();
  if (status) rows = rows.filter((r) => (r.status || "").includes(status));
  rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  out({ ok: true, count: rows.length, cases: rows });
}

function cmdRead(id) {
  const row = readAll().find((r) => r.id === id);
  if (!row) fail(`case not found: ${id}`);
  out({ ok: true, row });
}

async function cmdUpdate(id, json) {
  let patch;
  try { patch = JSON.parse(json); } catch (e) { fail(`bad updates JSON: ${e.message}`); }
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) fail(`case not found: ${id}`);
  rows[i] = normalize({ ...rows[i], ...patch, id, updated: nowIso() });
  writeAll(rows);
  const sheet = await pushToSheet("update", rows[i]);
  out({ ok: true, row: rows[i], sheet });
}

function cmdClaims(phone) {
  if (!phone) fail("phone required");
  const days = cfg()?.compensation_policy?.period_days ?? 90;
  const cutoff = Date.now() - days * 86400000;
  const norm = (p) => String(p || "").replace(/\D/g, "");
  const target = norm(phone);
  const matches = readAll().filter((r) =>
    r.type === "freshness" &&
    norm(r.customer_phone) === target &&
    Date.parse(r.created || 0) >= cutoff
  );
  out({ ok: true, phone: target, period_days: days, prior_claims: matches.length, cases: matches.map((m) => m.id) });
}

function cmdStats() {
  const rows = readAll();
  const by = (key) => rows.reduce((m, r) => { const k = r[key] || "—"; m[k] = (m[k] || 0) + 1; return m; }, {});
  out({ ok: true, total: rows.length, by_status: by("status"), by_type: by("type") });
}

function csvCell(v) {
  const s = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function cmdExportCsv(outfile) {
  const file = outfile || `${ROOT}/data/cases/cases.csv`;
  const rows = readAll();
  const lines = [FIELDS.join(",")];
  for (const r of rows) lines.push(FIELDS.map((f) => csvCell(r[f])).join(","));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  out({ ok: true, file, rows: rows.length });
}

// ---- dispatch ----------------------------------------------------------------------
async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "append": return cmdAppend(a);
    case "list": return cmdList(a);
    case "read": return cmdRead(a);
    case "update": return cmdUpdate(a, b);
    case "claims": return cmdClaims(a);
    case "stats": return cmdStats();
    case "export-csv": return cmdExportCsv(a);
    default:
      fail(`unknown command: ${cmd || "(none)"}`, {
        usage: ["append <json>", "list [status]", "read <id>", "update <id> <json>", "claims <phone>", "stats", "export-csv [outfile]"],
      });
  }
}

// export pure helpers for tests
export { genId, normalize, FIELDS, readAll };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fail(e.message));
}
