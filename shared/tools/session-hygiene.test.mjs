// shared/tools/session-hygiene.test.mjs
//
// Tests for the THIN CLI wrapper (shared/tools/session-hygiene.mjs). The decision logic itself is
// exhaustively tested in shared/lib/session-hygiene.test.mjs; here we only cover the wrapper's job:
// argv parsing, agent resolution via the registry, --all fan-out, exit-code contract, and that one
// failing agent in --all mode never aborts the rest. All runs use --dry-run so nothing is reset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from './session-hygiene.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'session-hygiene.mjs');

/** A logger that captures error lines instead of printing. */
function capLogger() {
  const errors = [];
  return { errors, error: (m) => errors.push(String(m)) };
}

/** Run the CLI as a subprocess; resolves {code, stdout, stderr}. Never rejects. */
function runCli(args) {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

test('no args -> usage error, exit 2', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test('--agent without a value -> usage error, exit 2', async () => {
  const r = await runCli(['--agent', '--dry-run']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test('unknown agent id -> exit 2 with clear message', async () => {
  const r = await runCli(['--agent', 'nope', '--dry-run']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown agentId: nope/);
});

test('--agent main --dry-run -> exit 0, logs the agent tag, never resets', async () => {
  const r = await runCli(['--agent', 'main', '--dry-run']);
  assert.equal(r.code, 0);
  // The lib logs "[session-hygiene-main ...]" for some action (disabled/no-session/noop/dry-run).
  assert.match(r.stdout, /session-hygiene-main/);
  // dry-run guarantees no RESET line ever claims success.
  assert.doesNotMatch(r.stdout, /reset OK/);
});

test('--all --dry-run -> exit 0, runs every LIVE agent with a sessionHygiene block', async () => {
  const r = await runCli(['--all', '--dry-run']);
  assert.equal(r.code, 0);
  // The 4 LIVE agents carry a sessionHygiene block; each should emit at least one log line.
  for (const id of ['main', 'digit', 'poker', 'zorro']) {
    assert.match(r.stdout, new RegExp(`session-hygiene-${id}`), `expected a log line for ${id}`);
  }
  // pitzi is archived (retired 2026-07-17): excluded from listAgents(), so --all never runs it.
  assert.doesNotMatch(r.stdout, /session-hygiene-pitzi/);
  assert.doesNotMatch(r.stdout, /reset OK/);
});

// ---- in-process tests with injected registry + runHygiene (deterministic, no real I/O) ----

const FAKE = [
  { agentId: 'a1', sessionHygiene: {} },
  { agentId: 'a2', sessionHygiene: {} },
  { agentId: 'a3', sessionHygiene: null }, // no block -> excluded by --all
];
const deps = (over = {}) => ({
  getAgent: (id) => FAKE.find((r) => r.agentId === id) || null,
  listAgents: () => FAKE.slice(),
  runHygiene: async () => ({ action: 'noop' }),
  logger: capLogger(),
  ...over,
});

test('--all (injected) runs only agents WITH a sessionHygiene block, exit 0', async () => {
  const ran = [];
  const d = deps({ runHygiene: async ({ record }) => { ran.push(record.agentId); } });
  const code = await main(['--all', '--dry-run'], d);
  assert.equal(code, 0);
  assert.deepEqual(ran, ['a1', 'a2']); // a3 (null block) excluded
});

test('--all keeps going after one agent throws, returns exit 1', async () => {
  const ran = [];
  const log = capLogger();
  const d = deps({
    logger: log,
    runHygiene: async ({ record }) => {
      ran.push(record.agentId);
      if (record.agentId === 'a1') throw new Error('boom');
    },
  });
  const code = await main(['--all'], d);
  assert.equal(code, 1);                       // some agent threw
  assert.deepEqual(ran, ['a1', 'a2']);         // a2 still ran after a1 failed
  assert.ok(log.errors.some((e) => /session-hygiene-a1\] fatal: boom/.test(e)));
});

test('single agent: lib throwing propagates as exit 1', async () => {
  const log = capLogger();
  const d = deps({ logger: log, runHygiene: async () => { throw new Error('kaboom'); } });
  const code = await main(['--agent', 'a1'], d);
  assert.equal(code, 1);
  assert.ok(log.errors.some((e) => /session-hygiene-a1\] fatal: kaboom/.test(e)));
});

test('mode flags are forwarded verbatim to runHygiene', async () => {
  let received;
  const d = deps({ runHygiene: async (args) => { received = args; } });
  const code = await main(['--agent', 'a1', '--force-reset-poisoned'], d);
  assert.equal(code, 0);
  assert.equal(received.forcePoisoned, true);
  assert.equal(received.forceReset, false);
  assert.equal(received.dryRun, false);
  assert.equal(received.record.agentId, 'a1');
});

test('new "defer: cron run active" action is a normal (exit 0) outcome, never a failure', async () => {
  // A run deferred because a cron run is in-flight (2026-07-15 cron-safety) must be treated exactly
  // like noop/disabled/no-session by the wrapper — a non-throwing run → exit 0, no false error.
  const log = capLogger();
  const d = deps({ logger: log, runHygiene: async () => ({ action: 'defer', reason: 'cron run active' }) });
  const code = await main(['--agent', 'a1'], d);
  assert.equal(code, 0);
  assert.equal(log.errors.length, 0, 'a deferred run is not an error');
});
