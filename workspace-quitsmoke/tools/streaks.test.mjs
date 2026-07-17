// End-to-end CLI test for streaks.mjs against an isolated ZORRO_DATA_DIR. Sheet I/O is forced
// OFFLINE by pointing ZORRO_CONFIG_PATH at a non-existent file → cfg() returns {} → pushToSheet
// short-circuits. (Relying on the real .config/bot.json having sheet.enabled=false was a trap:
// once it went true in prod, every test run POSTed the דני/שרה fixtures to the LIVE Google Sheet.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "streaks.mjs");
let DIR;

function run(args) {
  const stdout = execFileSync("node", [CLI, ...args], {
    env: { ...process.env, ZORRO_DATA_DIR: DIR, ZORRO_CONFIG_PATH: join(DIR, "no-such-bot.json") },
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

before(() => { DIR = mkdtempSync(join(tmpdir(), "zorro-")); });
after(() => { rmSync(DIR, { recursive: true, force: true }); });

test("add-member → read → list", () => {
  const a = run(["add-member", "דני", "0501234567", "--quit-date", "2026-06-20"]);
  assert.equal(a.ok, true);
  assert.equal(a.member.member_name, "דני");
  assert.equal(a.member.e164, "0501234567"); // e164 stored as digits-only (non-digits stripped)
  const r = run(["read", "דני"]);
  assert.equal(r.ok, true);
  assert.equal(r.member.member_name, "דני");
  const l = run(["list"]);
  assert.equal(l.count, 1);
});

test("duplicate add-member fails", () => {
  const dup = (() => { try { return run(["add-member", "דני"]); } catch (e) { return JSON.parse(String(e.stdout).trim()); } })();
  assert.equal(dup.ok, false);
});

test("checkin clean stamps and reports milestone, leaderboard ranks", () => {
  run(["add-member", "שרה", "", "--quit-date", "2026-06-25"]);
  const c = run(["checkin", "שרה", "clean", "--date", "2026-06-26"]);
  assert.equal(c.ok, true);
  assert.equal(c.was_relapse, false);
  assert.equal(c.member.last_result, "clean");
  const lb = run(["leaderboard", "--date", "2026-06-26"]);
  assert.equal(lb.ok, true);
  assert.equal(lb.table[0].member_name, "דני"); // 6 clean days > שרה's 1
  assert.equal(lb.table[0].clean_days, 6);
});

test("relapse resets streak and increments resets", () => {
  const r = run(["relapse", "דני", "--date", "2026-06-26"]);
  assert.equal(r.ok, true);
  assert.equal(r.was_relapse, true);
  assert.equal(r.member.total_resets, 1);
  assert.equal(r.member.clean_days, 0);
});

test("pending lists who hasn't checked in on a date", () => {
  const p = run(["pending", "--date", "2026-06-27"]);
  assert.equal(p.ok, true);
  // neither דני nor שרה checked in on the 27th
  assert.equal(p.pending.length, 2);
});

test("stats + export-csv", () => {
  const s = run(["stats", "--date", "2026-06-27"]);
  assert.equal(s.ok, true);
  assert.equal(s.stats.members, 2);
  const csv = run(["export-csv", join(DIR, "out.csv")]);
  assert.equal(csv.ok, true);
  assert.equal(csv.rows, 2);
});

test("sync-sheet --dry-run re-derives clean_days for every member (the daily-freshness fix)", () => {
  // clean_days is DERIVED from quit_date, so sync-sheet must report TODAY's value for each member
  // regardless of when they last checked in — this is what keeps the live Sheet from freezing.
  const r = run(["sync-sheet", "--dry-run", "--date", "2026-06-30"]);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.would_sync, r.rows.length);
  assert.equal(r.rows.length, 2); // דני + שרה
  const byName = Object.fromEntries(r.rows.map((m) => [m.member_name, m.clean_days]));
  assert.equal(byName["שרה"], 5);  // quit 2026-06-25 → 5 clean days on 06-30 (derived, not last-check)
  assert.equal(byName["דני"], 3);  // relapsed on 06-26 → quit_date 06-27 → 3 on 06-30
  assert.ok(r.rows.every((m) => typeof m.clean_days === "number"), "every row carries a numeric clean_days");
});

test("unknown command fails cleanly", () => {
  const u = (() => { try { return run(["frobnicate"]); } catch (e) { return JSON.parse(String(e.stdout).trim()); } })();
  assert.equal(u.ok, false);
});
