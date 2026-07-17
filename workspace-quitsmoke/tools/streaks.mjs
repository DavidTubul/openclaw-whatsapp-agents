#!/usr/bin/env node
// streaks.mjs — the deterministic "טבלת צדק" (streak/justice tracker) for זורו ⚔️,
// the quit-smoking coach. File-backed ledger of members + their smoke-free streaks.
// All output is JSON on stdout so the LLM can consume it; errors → {ok:false,error}.
//
// Source of truth (MVP): data/streaks/members.jsonl (append/rewrite, one JSON object/line).
// quit_date is the truth; clean_days is DERIVED (today - quit_date) so it can never drift.
// If .config/bot.json sheet.enabled=true, writes also POST to a Google Apps Script webhook
// (same pattern as Scotty's sheet.mjs / פיצי's cases.mjs) so the table lands in a live Sheet.
//
// Usage (run from workspace-quitsmoke/, or anywhere — paths are derived):
//   node tools/streaks.mjs add-member "<name>" [e164] [--quit-date YYYY-MM-DD]
//   node tools/streaks.mjs checkin "<name>" <clean|smoked> [--date YYYY-MM-DD]
//   node tools/streaks.mjs relapse "<name>" [--date YYYY-MM-DD]      # alias: checkin smoked
//   node tools/streaks.mjs read "<name>"
//   node tools/streaks.mjs list
//   node tools/streaks.mjs leaderboard [--date YYYY-MM-DD]           # the justice table
//   node tools/streaks.mjs pending [--date YYYY-MM-DD]               # who hasn't checked in
//   node tools/streaks.mjs stats [--date YYYY-MM-DD]
//   node tools/streaks.mjs sync-sheet [--dry-run] [--date YYYY-MM-DD]  # re-push all members' derived clean_days to the Sheet (daily)
//   node tools/streaks.mjs remind-pending [--dry-run] [--force] [--date YYYY-MM-DD]  # @tag + nudge members who didn't report today (1/day)
//   node tools/streaks.mjs set "<name>" '<patchJSON>'               # manual correction
//   node tools/streaks.mjs export-csv [outfile]
//
// --date defaults to today (host local date). All check-ins are about the PREVIOUS day's
// behaviour, but we record them under the date you pass (the coach calls --date yesterday or
// today as appropriate; default today keeps it simple for ad-hoc use).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, writeJsonl } from "../../shared/lib/jsonl.mjs";
import { todayInTz } from "../../shared/lib/time.mjs";
import { pushToSheet as pushToSheetShared } from "../../shared/lib/sheet-webhook.mjs";
import { getAgent, isPlaceholderJid } from "../../shared/lib/agent-registry.mjs";
import { launcherPath } from "../../shared/lib/paths.mjs";
import {
  newMember, resolveMember, applyCheckin, computeCleanDays, computeMoneySaved,
  leaderboard, pendingMembers, aggregateStats, normName,
} from "./lib/streaks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DATA_DIR = process.env.ZORRO_DATA_DIR || resolve(ROOT, "data");
const LEDGER = resolve(DATA_DIR, "streaks", "members.jsonl");
// CONFIG_PATH is overridable via ZORRO_CONFIG_PATH so tests can point it at a non-existent
// file → cfg() returns {} → pushToSheet short-circuits. Without this the ledger is isolated
// (ZORRO_DATA_DIR) but the LIVE sheet is NOT, so test fixtures (דני/שרה) leaked into the real
// Google Sheet every time the suite ran (e.g. via self-edit verify). Prod leaves it unset.
const CONFIG_PATH = process.env.ZORRO_CONFIG_PATH || resolve(ROOT, ".config", "bot.json");
const LAUNCHER = launcherPath; // repo-root launcher (nvm → openclaw CLI), from shared/lib/paths.mjs
const REMINDED_MARKER = resolve(DATA_DIR, "daily", "reminded.jsonl"); // idempotency: one nudge/day

// Column order for CSV + the Google Sheet.
const FIELDS = [
  "id", "member_name", "e164", "quit_date", "clean_days",
  "longest_streak", "total_resets", "last_check", "last_result",
  "weekly_spend", "money_saved", "joined", "updated",
];

function out(o) { console.log(JSON.stringify(o)); }
function fail(error, extra = {}) { console.log(JSON.stringify({ ok: false, error, ...extra })); process.exit(1); }
function nowIso() { return new Date().toISOString(); }
// Asia/Jerusalem, NOT UTC — with toISOString() a check-in between 00:00–03:00 Israel time was
// stamped on the PREVIOUS day (off-by-one clean_days + a double reminder at 20:00).
const today = () => todayInTz();

function cfg() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

// ---- ledger I/O -------------------------------------------------------------------

function readAll() {
  return readJsonl(LEDGER); // shared JSONL reader (skips blank/corrupt lines)
}

function writeAll(rows) {
  // Atomic (via shared writeJsonl): the ledger is the members' only source of truth, and the 04:30
  // sheet-sync timer writes it concurrently with conversational check-ins.
  writeJsonl(LEDGER, rows);
}

// ---- optional Google Sheet mirror (shared client: timeout + enabled-gate) ----------

async function pushToSheet(action, row) {
  return pushToSheetShared(cfg()?.sheet, action, row);
}

/** A member row enriched with the derived clean_days, ready for output/sheet. */
function withDerived(m, date) {
  return { ...m, clean_days: computeCleanDays(m, date), money_saved: computeMoneySaved(m, date) };
}

// ---- arg parsing ------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { flags[a.slice(2)] = args[i + 1]?.startsWith("--") || args[i + 1] === undefined ? true : args[++i]; }
    else pos.push(a);
  }
  return { pos, flags };
}

// ---- commands ---------------------------------------------------------------------

async function cmdAddMember(pos, flags) {
  const name = normName(pos[0]);
  if (!name) fail("add-member requires a name");
  const rows = readAll();
  if (resolveMember(rows, name)) fail(`member already exists: ${name}`);
  const quitDate = (typeof flags["quit-date"] === "string" && flags["quit-date"]) || today();
  const m = newMember({ name, e164: pos[1], quitDate, nowIso: nowIso() });
  rows.push(m);
  writeAll(rows);
  const sheet = await pushToSheet("append", withDerived(m, today()));
  out({ ok: true, member: withDerived(m, today()), sheet });
}

async function cmdCheckin(pos, flags) {
  const name = pos[0];
  const result = (pos[1] || "").toLowerCase();
  if (!name) fail("checkin requires a name");
  if (result !== "clean" && result !== "smoked") fail("checkin result must be 'clean' or 'smoked'");
  const date = (typeof flags.date === "string" && flags.date) || today();
  const rows = readAll();
  const m = resolveMember(rows, name);
  if (!m) fail(`member not found: ${name}`, { hint: "add-member first" });
  const res = applyCheckin(m, result, date);
  res.member.updated = nowIso();
  const i = rows.findIndex((r) => r.id === m.id);
  rows[i] = res.member;
  writeAll(rows);
  const sheet = await pushToSheet("update", withDerived(res.member, date));
  out({
    ok: true,
    result,
    member: withDerived(res.member, date),
    clean_days: res.cleanDays,
    was_relapse: res.wasRelapse,
    milestones_crossed: res.crossed,
    sheet,
  });
}

async function cmdSet(pos) {
  const name = pos[0];
  if (!name) fail("set requires a name");
  let patch;
  try { patch = JSON.parse(pos[1]); } catch (e) { fail(`bad patch JSON: ${e.message}`); }
  const rows = readAll();
  const m = resolveMember(rows, name);
  if (!m) fail(`member not found: ${name}`);
  const i = rows.findIndex((r) => r.id === m.id);
  rows[i] = { ...m, ...patch, id: m.id, updated: nowIso() };
  writeAll(rows);
  const sheet = await pushToSheet("update", withDerived(rows[i], today()));
  out({ ok: true, member: withDerived(rows[i], today()), sheet });
}

function cmdRead(pos) {
  const m = resolveMember(readAll(), pos[0]);
  if (!m) fail(`member not found: ${pos[0]}`);
  out({ ok: true, member: withDerived(m, today()) });
}

function cmdList() {
  const date = today();
  out({ ok: true, count: readAll().length, members: readAll().map((m) => withDerived(m, date)) });
}

function cmdLeaderboard(flags) {
  const date = (typeof flags.date === "string" && flags.date) || today();
  out({ ok: true, date, table: leaderboard(readAll(), date) });
}

function cmdPending(flags) {
  const date = (typeof flags.date === "string" && flags.date) || today();
  out({ ok: true, date, pending: pendingMembers(readAll(), date).map((m) => withDerived(m, date)) });
}

function cmdStats(flags) {
  const date = (typeof flags.date === "string" && flags.date) || today();
  out({ ok: true, date, stats: aggregateStats(readAll(), date) });
}

// Re-push EVERY member's current derived state to the Google Sheet. This is what keeps the
// "justice table" alive between check-ins: clean_days is DERIVED from quit_date, so it grows
// every day on its own — but the Sheet only ever saw the value from the last write (add-member/
// checkin), so without this it freezes (e.g. shows "0" on day 1). Run it deterministically every
// morning (systemd timer openclaw-zorro-sheet-sync) so the table is correct even when nobody
// checked in and regardless of whether the conversational session is alive. Idempotent.
// `--dry-run` returns exactly what WOULD be pushed without hitting the network (used by tests).
async function cmdSyncSheet(flags) {
  const date = (typeof flags.date === "string" && flags.date) || today();
  const rawRows = readAll();
  // Update longest_streak in ledger if clean_days has grown past it (e.g. after a set/quit_date change)
  let ledgerDirty = false;
  const rows = rawRows.map((m) => {
    const derived = withDerived(m, date);
    if (derived.clean_days > (m.longest_streak || 0)) {
      ledgerDirty = true;
      return { ...m, longest_streak: derived.clean_days, clean_days: derived.clean_days };
    }
    return derived;
  });
  if (ledgerDirty) writeAll(rows.map(({ clean_days: _cd, money_saved: _ms, ...rest }) => rest));
  if (flags["dry-run"]) {
    out({ ok: true, dryRun: true, date, would_sync: rows.length, rows });
    return;
  }
  const c = cfg();
  if (!c?.sheet?.enabled || !c?.sheet?.webhook_url) {
    out({ ok: true, date, synced: 0, skipped: "sheet disabled" });
    return;
  }
  const results = [];
  for (const r of rows) {
    const res = await pushToSheet("update", r);
    results.push({ id: r.id, clean_days: r.clean_days, ok: !!(res && res.ok), status: res && res.status });
  }
  const sorted = await pushToSheet("sort", {}); // keep the table ordered by clean_days desc
  out({ ok: results.every((r) => r.ok), date, synced: results.length, results, sorted });
}

// Brutal zorro-voice nudges for members who haven't reported today (rotated by date).
const REMIND_NUDGES = [
  "עוד לא דיווחתם היום, עבדים. מה קרה, נשברתם ומתביישים להגיד? תכתבו 'נקי' או 'נפלתי' — עכשיו.",
  "אני מחכה ואתם שותקים. עבד ששותק זה עבד שמסתיר. דיווח יומי: 'נקי' או 'עישנתי'. זוזו.",
  "לא שמעתי מכם היום. הטבלה לא מתמלאת לבד. תדווחו עכשיו לפני שאני מחליט בעצמי שנפלתם.",
];

// Remind members who haven't checked in today — DETERMINISTIC + RESILIENT: this runs from a systemd
// timer (not the LLM), tags each pending member with @<e164> (real WhatsApp mention → notification),
// and sends ONE nudge per day (idempotent marker), only if there ARE pending members. Survives any
// session crash because it owns the whole flow itself. `--dry-run` builds+prints, never sends/marks.
// Gate: bot.json `reminders.enabled` (default true) + a configured group_id.
async function cmdRemindPending(flags) {
  const date = (typeof flags.date === "string" && flags.date) || today();
  const c = cfg();
  if (c?.reminders?.enabled === false) { out({ ok: true, date, skipped: "reminders disabled in bot.json" }); return; }
  // Group id comes from the registry (shared/registry.json), the single source of truth — not from
  // bot.json (that wiring field was removed 2026-07-17). reminders.enabled stays in bot.json (domain).
  // On a fresh clone the registry loader falls back to registry.example.json, where zorro's jid is
  // the literal placeholder '<ZORRO_GROUP_ID>@g.us' — sending to that is garbage. isPlaceholderJid
  // (shared with boot-notify's guard) rejects both a missing jid and a placeholder → clean skip.
  const group = getAgent("zorro")?.primaryGroupId;
  if (isPlaceholderJid(group)) { out({ ok: true, date, skipped: "no group configured" }); return; }

  const pend = pendingMembers(readAll(), date);
  if (pend.length === 0) { out({ ok: true, date, pending: 0, skipped: "everyone reported — nothing to nudge" }); return; }

  // Idempotency: at most one nudge per day (unless --force).
  if (!flags.force && existsSync(REMINDED_MARKER)) {
    const already = readFileSync(REMINDED_MARKER, "utf8").split("\n").some((l) => {
      try { return JSON.parse(l)?.date === date; } catch { return false; }
    });
    if (already) { out({ ok: true, date, pending: pend.length, skipped: "already reminded today" }); return; }
  }

  const tags = pend.map((m) => (m.e164 ? `@${m.e164}` : null)).filter(Boolean).join(" ");
  const nudge = REMIND_NUDGES[Number(date.replace(/-/g, "")) % REMIND_NUDGES.length];
  const message = (tags ? tags + "\n\n" : "") + nudge;

  if (flags["dry-run"]) {
    out({ ok: true, dryRun: true, date, pending: pend.length, names: pend.map((m) => m.member_name), message });
    return;
  }
  try {
    execFileSync(LAUNCHER, ["message", "send", "--channel", "whatsapp", "--target", group, "-m", message], { timeout: 30000, encoding: "utf8" });
  } catch (e) {
    out({ ok: false, date, pending: pend.length, error: `send failed: ${e?.message || e}` });
    process.exit(1);
  }
  mkdirSync(dirname(REMINDED_MARKER), { recursive: true });
  appendFileSync(REMINDED_MARKER, JSON.stringify({ date, ids: pend.map((m) => m.id), at: nowIso() }) + "\n");
  out({ ok: true, date, reminded: pend.length, names: pend.map((m) => m.member_name), message });
}

function cmdExportCsv(pos) {
  const date = today();
  const rows = readAll().map((m) => withDerived(m, date));
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [FIELDS.join(","), ...rows.map((r) => FIELDS.map((f) => esc(r[f])).join(","))].join("\n") + "\n";
  const outfile = pos[0] || resolve(DATA_DIR, "streaks", "members.csv");
  writeFileSync(outfile, csv);
  out({ ok: true, wrote: outfile, rows: rows.length });
}

// ---- main -------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseFlags(rest);
  switch (cmd) {
    case "add-member": return cmdAddMember(pos, flags);
    case "checkin": return cmdCheckin(pos, flags);
    case "relapse": return cmdCheckin([pos[0], "smoked"], flags);
    case "set": return cmdSet(pos);
    case "read": return cmdRead(pos);
    case "list": return cmdList();
    case "leaderboard": return cmdLeaderboard(flags);
    case "pending": return cmdPending(flags);
    case "stats": return cmdStats(flags);
    case "sync-sheet": return cmdSyncSheet(flags);
    case "remind-pending": return cmdRemindPending(flags);
    case "export-csv": return cmdExportCsv(pos);
    default:
      fail(`unknown command: ${cmd ?? "(none)"} — use add-member|checkin|relapse|read|list|leaderboard|pending|stats|sync-sheet|remind-pending|export-csv`);
  }
}

main();
