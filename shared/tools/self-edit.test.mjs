// shared/tools/self-edit.test.mjs
//
// Tests for the THIN CLI wrapper (shared/tools/self-edit.mjs). The snapshot/verify/revert/log
// engine is exhaustively tested in shared/lib/self-edit.test.mjs; here we only cover the wrapper's
// job: parse + strip `--agent <id>` (with SELF_EDIT_AGENT fallback), resolve the agent's self-edit
// config via the registry, and PRESERVE the per-bot stdout + exit-code contract exactly:
//   • exactly one JSON line on stdout per invocation
//   • success → exit 0 ; verify-not-ok → exit 2 ; any other failure → exit 1
//
// SELF_EDIT_DIR is pointed at a temp dir so no run ever touches a real bot's audit trail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAgent } from './self-edit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'self-edit.mjs');

/** Run the CLI as a subprocess; resolves {code, stdout, stderr}. Never rejects. */
function runCli(args, extraEnv = {}) {
  const env = {
    ...process.env,
    // Isolate the audit trail so snapshot/log never pollute a real workspace.
    SELF_EDIT_DIR: mkdtempSync(path.join(tmpdir(), 'self-edit-test-')),
    ...extraEnv,
  };
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { timeout: 120000, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Parse the single JSON line the CLI is contractually required to print. */
function soleJson(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one stdout line, got ${lines.length}: ${stdout}`);
  return JSON.parse(lines[0]);
}

// ───────────────────────────── pure parseAgent() ─────────────────────────────

test('parseAgent: --agent <id> is parsed and stripped, rest is the subcommand', () => {
  const { agent, rest } = parseAgent(['--agent', 'zorro', 'verify', '--tests-only'], {});
  assert.equal(agent, 'zorro');
  assert.deepEqual(rest, ['verify', '--tests-only']);
});

test('parseAgent: --agent stripped from the MIDDLE leaves the rest intact', () => {
  const { agent, rest } = parseAgent(['verify', '--agent', 'main', '--tests-only'], {});
  assert.equal(agent, 'main');
  assert.deepEqual(rest, ['verify', '--tests-only']);
});

test('parseAgent: SELF_EDIT_AGENT env is the fallback when --agent is absent', () => {
  const { agent, rest } = parseAgent(['changelog', '3'], { SELF_EDIT_AGENT: 'poker' });
  assert.equal(agent, 'poker');
  assert.deepEqual(rest, ['changelog', '3']);
});

test('parseAgent: explicit --agent overrides the env fallback', () => {
  const { agent } = parseAgent(['--agent', 'main', 'verify'], { SELF_EDIT_AGENT: 'poker' });
  assert.equal(agent, 'main');
});

test('parseAgent: no agent anywhere -> undefined', () => {
  const { agent } = parseAgent(['verify'], {});
  assert.equal(agent, undefined);
});

// ───────────────────────────── CLI contract ─────────────────────────────────

test('no --agent and no env -> {ok:false} + exit 1', async () => {
  const r = await runCli(['verify'], { SELF_EDIT_AGENT: '' });
  assert.equal(r.code, 1);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /no agent|SELF_EDIT_AGENT/);
});

test('unknown agent id -> {ok:false} + exit 1', async () => {
  const r = await runCli(['--agent', 'nope', 'verify'], { SELF_EDIT_AGENT: '' });
  assert.equal(r.code, 1);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /unknown agent: nope/);
});

test('unwired agent (digit) -> {ok:false, no harness} + exit 1', async () => {
  const r = await runCli(['--agent', 'digit', 'verify'], { SELF_EDIT_AGENT: '' });
  assert.equal(r.code, 1);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /no self-edit harness/);
});

test('archived agent (pitzi) -> {ok:false} + exit 1 (retired: getAgent hides it)', async () => {
  // pitzi is archived (retired 2026-07-17). getAgent() no longer resolves it by default, so the
  // self-edit CLI reports it as unknown and exits non-zero — a retired bot cannot self-edit.
  const r = await runCli(['--agent', 'pitzi', 'verify'], { SELF_EDIT_AGENT: '' });
  assert.equal(r.code, 1);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /unknown agent: pitzi/);
});

test('unknown subcommand for a wired agent -> {ok:false} + exit 1', async () => {
  const r = await runCli(['--agent', 'zorro', 'frobnicate']);
  assert.equal(r.code, 1);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, false);
  assert.match(j.error, /unknown command/);
});

test('verify --tests-only for a wired agent (zorro) -> exit 0, {ok:true,checks}', async () => {
  const r = await runCli(['--agent', 'zorro', 'verify', '--tests-only']);
  assert.equal(r.code, 0);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.checks) && j.checks.length > 0);
  // --tests-only path runs the suite + (zorro) the core-tool parse-check, NOT the syntax/json sweep.
  assert.ok(j.checks.some((c) => c.name === 'unit-tests' && c.ok));
  assert.ok(j.checks.some((c) => c.name === 'core-tool:streaks.mjs'));
  assert.ok(!j.checks.some((c) => c.name.startsWith('json:')));
});

test('full verify for a wired agent (zorro) -> exit 0 and includes syntax + guarded-json checks', async () => {
  const r = await runCli(['--agent', 'zorro', 'verify']);
  assert.equal(r.code, 0);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, true);
  assert.ok(j.checks.some((c) => c.name.startsWith('syntax:')));
  assert.ok(j.checks.some((c) => c.name === 'json:.config/bot.json' && c.ok));
});

test('changelog for a wired agent with an isolated audit dir -> exit 0, empty entries', async () => {
  const r = await runCli(['--agent', 'main', 'changelog', '5']);
  assert.equal(r.code, 0);
  const j = soleJson(r.stdout);
  assert.equal(j.ok, true);
  assert.deepEqual(j.entries, []);
});

test('SELF_EDIT_AGENT env fallback drives a real run when --agent is omitted', async () => {
  const r = await runCli(['changelog', '1'], { SELF_EDIT_AGENT: 'poker' });
  assert.equal(r.code, 0);
  assert.equal(soleJson(r.stdout).ok, true);
});

test('snapshot then revert round-trips for a wired agent via the wrapper', async () => {
  // One isolated audit dir for both calls so the snapshot id is findable by revert.
  const env = {
    ...process.env,
    SELF_EDIT_DIR: mkdtempSync(path.join(tmpdir(), 'self-edit-rt-')),
  };
  const run = (args) =>
    new Promise((resolve) => {
      execFile('node', [CLI, ...args], { timeout: 60000, env }, (err, stdout) =>
        resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '' }),
      );
    });
  // Snapshot an existing, in-workspace file (the bot config) — read-only round-trip, no edit.
  const snap = await run(['--agent', 'zorro', 'snapshot', JSON.stringify(['.config/bot.json'])]);
  assert.equal(snap.code, 0);
  const snapJson = soleJson(snap.stdout);
  assert.equal(snapJson.ok, true);
  assert.ok(snapJson.snapshot_id);
  // Revert restores it (unchanged) — exit 0.
  const rev = await run(['--agent', 'zorro', 'revert', snapJson.snapshot_id]);
  assert.equal(rev.code, 0);
  const revJson = soleJson(rev.stdout);
  assert.equal(revJson.ok, true);
  assert.equal(revJson.snapshot_id, snapJson.snapshot_id);
});
