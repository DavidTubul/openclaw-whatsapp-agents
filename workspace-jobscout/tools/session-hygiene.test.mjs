import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGroupSession, isIdle, isWithinWindow, decide, isPoisoned, decideForce, decideProactivePoison } from "./session-hygiene.mjs";

const KEY = "agent:main:whatsapp:group:120363000000000000@g.us";

test("resolveGroupSession returns sid+file when present, null otherwise", () => {
  const store = { [KEY]: { sessionId: "s1", sessionFile: "/f/s1.jsonl" }, other: {} };
  assert.deepEqual(resolveGroupSession(store, KEY), { sessionId: "s1", sessionFile: "/f/s1.jsonl" });
  assert.equal(resolveGroupSession({}, KEY), null);
  assert.equal(resolveGroupSession({ [KEY]: { sessionId: "s1" } }, KEY), null);
});

test("isIdle: true when transcript untouched longer than idleSecs", () => {
  const now = 1_000_000;
  assert.equal(isIdle(now - 200_000, now, 90), true);
  assert.equal(isIdle(now - 10_000, now, 90), false);
});

test("isPoisoned: assistant-only transcript (the real failure) → true", () => {
  // mirrors the actual poisoned transcript: session/custom/thinking lines + assistant turns, 0 user
  const lines = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "thinking_level_change" }),
    JSON.stringify({ message: { role: "assistant", content: "scout report" } }),
    JSON.stringify({ message: { role: "assistant", content: "reset notice" } }),
    JSON.stringify({ type: "custom" }),
  ].join("\n");
  assert.equal(isPoisoned(lines), true);
});

test("isPoisoned: healthy transcript with a user turn → false (idle-gate respected)", () => {
  const lines = [
    JSON.stringify({ message: { role: "assistant", content: "hi" } }),
    JSON.stringify({ message: { role: "user", content: "real question" } }),
    JSON.stringify({ message: { role: "assistant", content: "answer" } }),
  ].join("\n");
  assert.equal(isPoisoned(lines), false);
});

test("isPoisoned: empty / no assistant messages → false (nothing to recover)", () => {
  assert.equal(isPoisoned(""), false);
  assert.equal(isPoisoned("\n  \n"), false);
  assert.equal(isPoisoned(JSON.stringify({ type: "session" })), false);
});

test("isPoisoned: tolerates non-JSON / blank lines, reads role|message.role|type", () => {
  const lines = [
    "not json at all",
    "",
    JSON.stringify({ role: "assistant", content: "x" }),
    JSON.stringify({ type: "user" }),  // user via top-level type → not poisoned
  ].join("\n");
  assert.equal(isPoisoned(lines), false);
});

test("decideForce: poisoned + BUSY (not idle) → RESET — the core fix (busy group never idles)", () => {
  const d = decideForce({ forceReset: false, forcePoisoned: true, poisoned: true, idle: false });
  assert.equal(d.reset, true);
  assert.equal(d.deferred, false);
});

test("decideForce: poisoned + idle → RESET too", () => {
  assert.equal(decideForce({ forcePoisoned: true, poisoned: true, idle: true }).reset, true);
});

test("decideForce: NOT poisoned + busy → DEFER (healthy busy chat never interrupted)", () => {
  const d = decideForce({ forceReset: false, forcePoisoned: true, poisoned: false, idle: false });
  assert.equal(d.reset, false);
  assert.equal(d.deferred, true);
});

test("decideForce: NOT poisoned + idle → reset (fallback to plain force-reset)", () => {
  assert.equal(decideForce({ forcePoisoned: true, poisoned: false, idle: true }).reset, true);
});

test("decideForce: plain --force-reset still idle-gated (busy → defer, idle → reset)", () => {
  assert.equal(decideForce({ forceReset: true, forcePoisoned: false, idle: false }).reset, false);
  assert.equal(decideForce({ forceReset: true, forcePoisoned: false, idle: true }).reset, true);
});

test("decideProactivePoison: assistant-only session → reset, SILENT, idle-gate bypassed (the morning fix)", () => {
  const d = decideProactivePoison({ poisoned: true });
  assert.equal(d.reset, true);
  assert.equal(d.deferred, false);
  assert.equal(d.silent, true, "must be silent — a notify would re-create an assistant-only session and re-poison");
  assert.equal(d.recordDaily, false);
});

test("decideProactivePoison: healthy session → no reset (and never announces)", () => {
  const d = decideProactivePoison({ poisoned: false });
  assert.equal(d.reset, false);
  assert.equal(d.silent, true);
});

test("isWithinWindow: minute-of-day inside [start, start+span)", () => {
  assert.equal(isWithinWindow(7, 32, 7, 30, 10), true);
  assert.equal(isWithinWindow(7, 30, 7, 30, 10), true);
  assert.equal(isWithinWindow(7, 40, 7, 30, 10), false);
  assert.equal(isWithinWindow(8, 0, 7, 30, 10), false);
});

test("decide: below thresholds → no reset", () => {
  const d = decide({ bytes: 500, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false });
  assert.deepEqual({ reset: d.reset, deferred: d.deferred, recordDaily: d.recordDaily }, { reset: false, deferred: false, recordDaily: false });
});

test("decide: size hit + idle → reset (not daily)", () => {
  const d = decide({ bytes: 2000, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(d.reset, true); assert.equal(d.recordDaily, false);
});

test("decide: size hit but busy → deferred, no reset", () => {
  const d = decide({ bytes: 2000, maxBytes: 1000, idle: false, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(d.reset, false); assert.equal(d.deferred, true);
});

test("decide: daily window + idle + not done → reset and recordDaily", () => {
  const d = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: false });
  assert.equal(d.reset, true); assert.equal(d.recordDaily, true);
});

test("decide: daily window but already done today → no reset", () => {
  const d = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: true });
  assert.equal(d.reset, false);
});

import { performReset } from "./session-hygiene.mjs";
import { mkdtemp, writeFile as wf, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("performReset: backup store, archive transcript, run cleanup — in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyg-"));
  const store = join(dir, "sessions.json");
  const tx = join(dir, "s1.jsonl");
  await wf(store, JSON.stringify({ k: { sessionId: "s1", sessionFile: tx } }));
  await wf(tx, "line1\nline2\n");
  const calls = [];
  const runCleanup = async () => { calls.push("cleanup"); return { code: 0 }; };
  const res = await performReset({ storePath: store, sessionFile: tx, ts: "20260530-070000", runCleanup });
  assert.equal(res.ok, true);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith("sessions.json.bak-")), "backup made");
  assert.ok(files.some((f) => f === "s1.jsonl.archived-20260530-070000"), "transcript archived");
  assert.ok(!files.includes("s1.jsonl"), "original transcript moved");
  assert.deepEqual(calls, ["cleanup"], "cleanup invoked after archive");
});

test("performReset: if archive fails, abort BEFORE cleanup (no broken state)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyg-"));
  const store = join(dir, "sessions.json");
  await wf(store, JSON.stringify({ k: {} }));
  let cleanupCalled = false;
  const runCleanup = async () => { cleanupCalled = true; return { code: 0 }; };
  const res = await performReset({ storePath: store, sessionFile: join(dir, "missing.jsonl"), ts: "x", runCleanup });
  assert.equal(res.ok, false);
  assert.equal(cleanupCalled, false, "cleanup NOT called when archive fails");
});
