import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(LIB_DIR, '..');
const WORKSPACE = resolve(TOOLS_DIR, '..');
const CLI = join(TOOLS_DIR, 'self-edit.mjs');

// All test fixtures live under the workspace (self-edit refuses paths outside it) in a
// throwaway dir we clean up. Snapshots + changelog are redirected via SELF_EDIT_DIR so
// the test never pollutes the real audit trail.
const SANDBOX_REL = 'data/self-edit/_test';
const SANDBOX_ABS = join(WORKSPACE, SANDBOX_REL);
const ENV = { ...process.env, SELF_EDIT_DIR: join(SANDBOX_ABS, '_store') };

// Leave no artifacts behind — every `verify` runs this suite, so a stray sandbox would
// otherwise accumulate under the real data dir.
after(() => rmSync(SANDBOX_ABS, { recursive: true, force: true }));

function run(args) {
  const stdout = execFileSync('node', [CLI, ...args], { cwd: TOOLS_DIR, encoding: 'utf8', env: ENV });
  return JSON.parse(stdout.trim().split('\n').pop());
}
function runExpectExit(args) {
  try { execFileSync('node', [CLI, ...args], { cwd: TOOLS_DIR, encoding: 'utf8', env: ENV }); return { code: 0 }; }
  catch (e) { return { code: e.status, stdout: e.stdout }; }
}

test('snapshot → edit existing file → revert restores original content', () => {
  mkdirSync(SANDBOX_ABS, { recursive: true });
  const rel = `${SANDBOX_REL}/existing.txt`;
  const abs = join(WORKSPACE, rel);
  writeFileSync(abs, 'ORIGINAL');

  const snap = run(['snapshot', JSON.stringify([rel])]);
  assert.equal(snap.ok, true);
  assert.match(snap.snapshot_id, /^\d{8}-\d{6}-\w{4}$/);
  assert.deepEqual(snap.files, [{ path: rel, existed: true }]);

  writeFileSync(abs, 'BROKEN EDIT');             // simulate a bad self-edit
  assert.equal(readFileSync(abs, 'utf8'), 'BROKEN EDIT');

  const rev = run(['revert', snap.snapshot_id]);
  assert.equal(rev.ok, true);
  assert.equal(readFileSync(abs, 'utf8'), 'ORIGINAL');  // restored

  rmSync(SANDBOX_ABS, { recursive: true, force: true });
});

test('snapshot of a NOT-yet-existing file → revert deletes the newly-created file', () => {
  mkdirSync(SANDBOX_ABS, { recursive: true });
  const rel = `${SANDBOX_REL}/brand-new.txt`;
  const abs = join(WORKSPACE, rel);
  rmSync(abs, { force: true });

  const snap = run(['snapshot', JSON.stringify([rel])]);
  assert.deepEqual(snap.files, [{ path: rel, existed: false }]);

  writeFileSync(abs, 'a feature file the agent created');  // edit creates it
  assert.equal(existsSync(abs), true);

  run(['revert', snap.snapshot_id]);
  assert.equal(existsSync(abs), false);   // revert removed the new file

  rmSync(SANDBOX_ABS, { recursive: true, force: true });
});

test('snapshot refuses a path outside the workspace', () => {
  const r = runExpectExit(['snapshot', JSON.stringify(['/etc/hosts'])]);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /outside the workspace/);
});

test('log appends then changelog reads it back', () => {
  const summary = `unit-test-entry-${Math.random().toString(36).slice(2, 8)}`;
  const logged = run(['log', JSON.stringify({ summary, files: ['x'] })]);
  assert.equal(logged.ok, true);
  assert.ok(logged.logged.ts);

  const cl = run(['changelog', '50']);
  assert.equal(cl.ok, true);
  assert.ok(cl.entries.some((e) => e.summary === summary));
});

test('verify --tests-only runs the suite and reports ok', { skip: process.env.SELF_EDIT_VERIFYING ? 'inside a verify run (avoid recursion)' : false }, () => {
  // When run directly this exercises verify; when run BY a verify (which sets
  // SELF_EDIT_VERIFYING), it skips — so verify can never re-enter verify recursively.
  const r = run(['verify', '--tests-only']);
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.checks));
  assert.ok(r.checks.some((c) => c.name === 'unit-tests'));
});

test('unknown command fails cleanly', () => {
  const r = runExpectExit(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /unknown command/);
});
