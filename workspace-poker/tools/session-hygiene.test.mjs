import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGroupSession, isIdle, isWithinWindow, decide, isPoisoned, decideForce, decideProactivePoison, performReset } from "./session-hygiene.mjs";
import { mkdtemp, writeFile as wf, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "agent:poker:whatsapp:group:120363000000000000@g.us";

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

test("isPoisoned: assistant-only → true, healthy (has user) → false, empty → false", () => {
  const poison = [
    JSON.stringify({ type: "session" }),
    JSON.stringify({ message: { role: "assistant", content: "x" } }),
  ].join("\n");
  assert.equal(isPoisoned(poison), true);
  const healthy = [
    JSON.stringify({ message: { role: "user", content: "דילר היי" } }),
    JSON.stringify({ message: { role: "assistant", content: "שלום" } }),
  ].join("\n");
  assert.equal(isPoisoned(healthy), false);
  assert.equal(isPoisoned(""), false);
  assert.equal(isPoisoned(JSON.stringify({ type: "session" })), false);
});

test("decideForce: poisoned+busy → reset; not-poisoned+busy → defer; idle → reset", () => {
  assert.equal(decideForce({ forcePoisoned: true, poisoned: true, idle: false }).reset, true);
  assert.equal(decideForce({ forcePoisoned: true, poisoned: false, idle: false }).reset, false);
  assert.equal(decideForce({ forcePoisoned: true, poisoned: false, idle: true }).reset, true);
  assert.equal(decideForce({ forceReset: true, idle: false }).reset, false);
  assert.equal(decideForce({ forceReset: true, idle: true }).reset, true);
});

test("decideProactivePoison: poisoned → silent reset; healthy → noop", () => {
  const d = decideProactivePoison({ poisoned: true });
  assert.equal(d.reset, true); assert.equal(d.silent, true);
  assert.equal(decideProactivePoison({ poisoned: false }).reset, false);
});

test("isWithinWindow", () => {
  assert.equal(isWithinWindow(6, 2, 6, 0, 10), true);
  assert.equal(isWithinWindow(6, 0, 6, 0, 10), true);
  assert.equal(isWithinWindow(6, 10, 6, 0, 10), false);
});

test("decide: size/daily/idle matrix", () => {
  assert.equal(decide({ bytes: 500, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false }).reset, false);
  assert.equal(decide({ bytes: 2000, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false }).reset, true);
  assert.equal(decide({ bytes: 2000, maxBytes: 1000, idle: false, inDailyWindow: false, dailyAlreadyDone: false }).deferred, true);
  const dly = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: false });
  assert.equal(dly.reset, true); assert.equal(dly.recordDaily, true);
  assert.equal(decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: true }).reset, false);
});

test("performReset: backup + archive + cleanup in order; aborts before cleanup if archive fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phyg-"));
  const store = join(dir, "sessions.json");
  const tx = join(dir, "s1.jsonl");
  await wf(store, JSON.stringify({ k: { sessionId: "s1", sessionFile: tx } }));
  await wf(tx, "line1\nline2\n");
  const calls = [];
  const ok = await performReset({ storePath: store, sessionFile: tx, ts: "20260613-210000", runCleanup: async () => { calls.push("c"); return { code: 0 }; } });
  assert.equal(ok.ok, true);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith("sessions.json.bak-")));
  assert.ok(files.includes("s1.jsonl.archived-20260613-210000"));
  assert.ok(!files.includes("s1.jsonl"));
  assert.deepEqual(calls, ["c"]);

  const dir2 = await mkdtemp(join(tmpdir(), "phyg-"));
  const store2 = join(dir2, "sessions.json");
  await wf(store2, JSON.stringify({ k: {} }));
  let cleaned = false;
  const bad = await performReset({ storePath: store2, sessionFile: join(dir2, "missing.jsonl"), ts: "x", runCleanup: async () => { cleaned = true; return { code: 0 }; } });
  assert.equal(bad.ok, false);
  assert.equal(cleaned, false);
});
