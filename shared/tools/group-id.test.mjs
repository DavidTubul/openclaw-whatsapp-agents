// shared/tools/group-id.test.mjs
//
// Smoke tests for the read-only group-id CLI (shared/tools/group-id.mjs). Two layers:
//   1. Subprocess runs against the REAL registry — verifies the actual JIDs agent prompts rely on.
//   2. In-process runs with an injected getAgent + captured stdout — deterministic arg/exit contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from './group-id.mjs';
import { getAgent } from '../lib/agent-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'group-id.mjs');

/** Run the CLI as a subprocess; returns {code, stdout, stderr}. Never throws. */
function runCli(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/** stdout sink + stderr capturer for in-process runs. */
function sinks() {
  const outChunks = [];
  const errLines = [];
  return {
    out: { write: (s) => outChunks.push(s) },
    err: { error: (m) => errLines.push(String(m)) },
    stdout: () => outChunks.join(''),
    errors: () => errLines,
  };
}

// ---- subprocess against the real registry ----

test('main (default primary) prints the primary JID matching the registry', () => {
  const r = runCli(['main']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), getAgent('main').primaryGroupId);
  assert.match(r.stdout.trim(), /@g\.us$/);
});

test('digit all prints both answering group JIDs, one per line', () => {
  const r = runCli(['digit', 'all']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout.trim().split('\n'), getAgent('digit').groupIds);
  assert.equal(getAgent('digit').groupIds.length, 2);
});

test('no agentId -> usage error, exit 2', () => {
  const r = runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage:/);
});

test('unknown agentId -> exit 2 with clear message', () => {
  const r = runCli(['nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown agentId: nope/);
});

test('archived agent (pitzi) -> exit 2, reports "archived" (not a bare "unknown")', () => {
  // pitzi is retired (archived) — getAgent hides it, so there is no active send target. The CLI
  // distinguishes this from a typo via a {includeArchived:true} re-lookup.
  const r = runCli(['pitzi']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /archived/);
  assert.equal(r.stdout.trim(), '');
});

// ---- in-process with injected registry (deterministic) ----

const deps = (record, s) => ({ getAgent: () => record, out: s.out, err: s.err });

test('primary mode writes the primary JID + newline, exit 0', () => {
  const s = sinks();
  const code = main(['x'], deps({ agentId: 'x', primaryGroupId: 'P@g.us', groupIds: ['P@g.us'] }, s));
  assert.equal(code, 0);
  assert.equal(s.stdout(), 'P@g.us\n');
});

test('all mode joins every groupId with newlines', () => {
  const s = sinks();
  const code = main(['x', 'all'], deps({ agentId: 'x', primaryGroupId: 'A@g.us', groupIds: ['A@g.us', 'B@g.us'] }, s));
  assert.equal(code, 0);
  assert.equal(s.stdout(), 'A@g.us\nB@g.us\n');
});

test('bad mode -> usage error, exit 2, nothing on stdout', () => {
  const s = sinks();
  const code = main(['x', 'sideways'], deps({ agentId: 'x', primaryGroupId: 'P@g.us' }, s));
  assert.equal(code, 2);
  assert.equal(s.stdout(), '');
  assert.ok(s.errors().some((e) => /unknown mode: sideways/.test(e)));
});

test('agent with no group (listener-like) -> exit 1, nothing on stdout', () => {
  const s = sinks();
  const code = main(['listener'], deps({ agentId: 'listener', primaryGroupId: undefined, groupIds: [] }, s));
  assert.equal(code, 1);
  assert.equal(s.stdout(), '');
  assert.ok(s.errors().some((e) => /no primary group/.test(e)));
});

test('all mode with empty groupIds -> exit 1', () => {
  const s = sinks();
  const code = main(['listener', 'all'], deps({ agentId: 'listener', primaryGroupId: undefined, groupIds: [] }, s));
  assert.equal(code, 1);
  assert.ok(s.errors().some((e) => /no groups/.test(e)));
});

test('unknown agentId (injected null) -> exit 2', () => {
  const s = sinks();
  const code = main(['ghost'], { getAgent: () => null, out: s.out, err: s.err });
  assert.equal(code, 2);
  assert.ok(s.errors().some((e) => /unknown agentId: ghost/.test(e)));
});
