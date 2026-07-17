import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_EDIT = join(dirname(fileURLToPath(import.meta.url)), "self-edit.mjs");

// Run the harness with an isolated audit-trail dir so the real data/self-edit is never touched.
function run(args, selfEditDir) {
  const stdout = execFileSync("node", [SELF_EDIT, ...args], {
    encoding: "utf8",
    env: { ...process.env, SELF_EDIT_DIR: selfEditDir },
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}
function runExpectFail(args, selfEditDir) {
  try {
    execFileSync("node", [SELF_EDIT, ...args], {
      encoding: "utf8",
      env: { ...process.env, SELF_EDIT_DIR: selfEditDir },
    });
    throw new Error("expected non-zero exit");
  } catch (e) {
    const txt = String(e.stdout || "");
    return JSON.parse(txt.trim().split("\n").pop());
  }
}

async function freshDir() {
  return mkdtemp(join(tmpdir(), "zorro-selfedit-"));
}

test("log → changelog roundtrip", async () => {
  const d = await freshDir();
  const logged = run(["log", JSON.stringify({ summary: "hello", files: ["a.md"] })], d);
  assert.equal(logged.ok, true);
  assert.equal(logged.logged.summary, "hello");
  const cl = run(["changelog", "5"], d);
  assert.equal(cl.ok, true);
  assert.equal(cl.entries.length, 1);
  assert.equal(cl.entries[0].summary, "hello");
});

test("changelog on empty trail → []", async () => {
  const d = await freshDir();
  const cl = run(["changelog"], d);
  assert.deepEqual(cl, { ok: true, entries: [] });
});

test("snapshot of an existing workspace file, then revert restores it", async () => {
  // Snapshot/revert operate on the REAL workspace. Use a throwaway file we create + clean up
  // ourselves so the test depends on no pre-existing file and leaves no artifact.
  const d = await freshDir();
  const workspace = join(dirname(SELF_EDIT), "..");
  const rel = `data/.self-edit-test-${process.pid}-${Date.now()}.tmp`;
  const target = join(workspace, rel);
  const original = "original-content\n";
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, original);

  const snap = run(["snapshot", JSON.stringify([rel])], d);
  assert.equal(snap.ok, true);
  assert.match(snap.snapshot_id, /^\d{8}-\d{6}-/);
  assert.deepEqual(snap.files, [{ path: rel, existed: true }]);

  // mutate, then revert → restores byte-for-byte
  await writeFile(target, original + "MUTATED\n");
  const rev = run(["revert", snap.snapshot_id], d);
  assert.equal(rev.ok, true);
  assert.deepEqual(rev.reverted, [{ path: rel, action: "restored" }]);
  assert.equal(await readFile(target, "utf8"), original);

  // clean up the throwaway file
  await import("node:fs/promises").then((fs) => fs.rm(target, { force: true }));
});

test("snapshot of a NON-existing file, then revert deletes it (restores absent)", async () => {
  const d = await freshDir();
  const workspace = join(dirname(SELF_EDIT), "..");
  const rel = `data/.self-edit-new-${process.pid}-${Date.now()}.tmp`;
  const target = join(workspace, rel);

  const snap = run(["snapshot", JSON.stringify([rel])], d);
  assert.deepEqual(snap.files, [{ path: rel, existed: false }]);

  // the "edit" creates the new file; revert must delete it
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "created by edit\n");
  assert.equal(existsSync(target), true);
  const rev = run(["revert", snap.snapshot_id], d);
  assert.deepEqual(rev.reverted, [{ path: rel, action: "deleted (was new)" }]);
  assert.equal(existsSync(target), false);
});

test("snapshot rejects a path outside the workspace", async () => {
  const d = await freshDir();
  const r = runExpectFail(["snapshot", JSON.stringify(["../../etc/passwd"])], d);
  assert.equal(r.ok, false);
  assert.match(r.error, /outside the workspace/);
});

test("snapshot rejects a non-array argument", async () => {
  const d = await freshDir();
  const r = runExpectFail(["snapshot", JSON.stringify({ not: "array" })], d);
  assert.equal(r.ok, false);
});

test("revert of an unknown snapshot id fails cleanly", async () => {
  const d = await freshDir();
  const r = runExpectFail(["revert", "nope-does-not-exist"], d);
  assert.equal(r.ok, false);
  assert.match(r.error, /no such snapshot/);
});

test("unknown command fails", async () => {
  const d = await freshDir();
  const r = runExpectFail(["frobnicate"], d);
  assert.equal(r.ok, false);
});
