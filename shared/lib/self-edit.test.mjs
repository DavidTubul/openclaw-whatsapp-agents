// shared/lib/self-edit.test.mjs — unit + CLI tests for the unified self-edit engine.
//
// Covers (a) the pure helpers, (b) the engine methods against an isolated temp workspace, and
// (c) the CLI runner end-to-end (snapshot→revert restore/delete, log↔changelog, verify exit
// codes, the zorro core-tool + no-tests branches, path-escape refusal, unknown-command). All
// fixtures live in a fresh tmp workspace so nothing touches a real bot's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSelfEdit, normalizeSelfEditCfg, resolveInWorkspace, newSnapshotId,
  selfEditConfigForAgent, readJsonSafe,
} from './self-edit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, 'self-edit.mjs');

// Build an isolated temp workspace: <ws>/tools (+ optional lib), <ws>/.config, <ws>/data.
// `opts.tests` writes a passing|failing tools/*.test.mjs; `opts.coreTool` writes a tools/<name>.
function makeWorkspace(opts = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'selfedit-ws-'));
  mkdirSync(join(ws, 'tools'), { recursive: true });
  mkdirSync(join(ws, '.config'), { recursive: true });
  mkdirSync(join(ws, 'data'), { recursive: true });
  if (opts.tests === 'pass') {
    writeFileSync(join(ws, 'tools', 'sample.test.mjs'),
      "import {test} from 'node:test'; test('ok', () => {});\n");
  } else if (opts.tests === 'fail') {
    writeFileSync(join(ws, 'tools', 'sample.test.mjs'),
      "import {test} from 'node:test'; import a from 'node:assert/strict'; test('bad', () => a.equal(1,2));\n");
  }
  if (opts.coreTool) writeFileSync(join(ws, 'tools', opts.coreTool), '// valid\nexport const x = 1;\n');
  if (opts.guarded) for (const [rel, body] of Object.entries(opts.guarded)) writeFileSync(join(ws, rel), body);
  return ws;
}

function baseCfg(ws, extra = {}) {
  return {
    workspaceDir: ws,
    selfEditDir: join(ws, 'data', 'self-edit'),
    guardedJson: [],
    ...extra,
  };
}

// Drive the CLI exactly like the original standalone scripts (separate process, JSON last line).
// The cfg + args are embedded directly in the one-shot launcher (passing argv after `-e ... --`
// drops the first arg, so we inline them instead).
function cliLauncher(cfgEnv, args) {
  return `import {runCli} from ${JSON.stringify(ENGINE)}; runCli(${JSON.stringify(cfgEnv)}, ${JSON.stringify(args)});`;
}
function runCli(cfgEnv, args) {
  const stdout = execFileSync('node', ['--input-type=module', '-e', cliLauncher(cfgEnv, args)], { encoding: 'utf8' });
  return JSON.parse(stdout.trim().split('\n').pop());
}
function runCliExpectExit(cfgEnv, args) {
  try {
    const out = execFileSync('node', ['--input-type=module', '-e', cliLauncher(cfgEnv, args)], { encoding: 'utf8' });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || '') };
  }
}

// ───────────────────────────── pure helpers ─────────────────────────────────────────────────────

test('resolveInWorkspace: accepts in-workspace, rejects escapes', () => {
  const ws = '/home/x/ws';
  assert.deepEqual(resolveInWorkspace(ws, 'a/b.md'), { abs: '/home/x/ws/a/b.md', rel: 'a/b.md' });
  assert.deepEqual(resolveInWorkspace(ws, '/home/x/ws/c.md'), { abs: '/home/x/ws/c.md', rel: 'c.md' });
  assert.throws(() => resolveInWorkspace(ws, '../../etc/passwd'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, '/etc/hosts'), /outside the workspace/);
});

test('newSnapshotId: deterministic timestamp (Israel wall-clock) + 4-char suffix shape', () => {
  // 2026-06-26 09:08:07 UTC = 12:08:07 Asia/Jerusalem (IDT, UTC+3). The stamp is now in Israel
  // time (was host-local == UTC) — intended tz consolidation, so the id reads 12:08:07, not 09:08:07.
  const fixed = new Date('2026-06-26T09:08:07Z');
  const id = newSnapshotId(fixed, () => 0.123456789);
  assert.match(id, /^\d{8}-\d{6}-\w{4}$/);
  assert.ok(id.startsWith('20260626-120807-'));
});

test('normalizeSelfEditCfg: defaults + SELF_EDIT_DIR honored', () => {
  const a = normalizeSelfEditCfg({ workspaceDir: '/w' }, {});
  assert.equal(a.toolsDir, '/w/tools');
  assert.equal(a.selfEditDir, '/w/data/self-edit');
  assert.equal(a.changelog, '/w/data/self-edit/changelog.jsonl');
  const b = normalizeSelfEditCfg({ workspaceDir: '/w' }, { SELF_EDIT_DIR: '/tmp/iso' });
  assert.equal(b.selfEditDir, '/tmp/iso');
  const c = normalizeSelfEditCfg({ workspaceDir: '/w', coreTool: '/w/tools/streaks.mjs' }, {});
  assert.equal(c.coreToolName, 'streaks.mjs');
  assert.throws(() => normalizeSelfEditCfg({}, {}), /needs workspaceDir/);
});

test('selfEditConfigForAgent: registry-driven per-agent guarded lists + zorro core tool; block-less → null', () => {
  // The legacy `switch (rec.agentId)` was removed 2026-07-17 — the config now derives ENTIRELY from
  // the record's registry `selfEdit` block. These blocks mirror the live registry for main/poker/zorro
  // and reproduce the old switch output exactly. An agent with NO selfEdit block (digit/pitzi) → null.
  const main = selfEditConfigForAgent({ agentId: 'main', workspaceDir: '/w/main',
    selfEdit: { guardedJson: ['.config/people.json', '.config/job-scout.json'] } });
  assert.deepEqual(main.guardedJson, ['.config/people.json', '.config/job-scout.json']);
  const poker = selfEditConfigForAgent({ agentId: 'poker', workspaceDir: '/w/poker',
    selfEdit: { guardedJson: ['.config/bot.json'] } });
  assert.deepEqual(poker.guardedJson, ['.config/bot.json']);
  const zorro = selfEditConfigForAgent({ agentId: 'zorro', workspaceDir: '/w/zorro',
    selfEdit: { guardedJson: ['.config/bot.json'], coreTool: 'tools/streaks.mjs' } });
  assert.deepEqual(zorro.guardedJson, ['.config/bot.json']);
  assert.equal(zorro.coreTool, '/w/zorro/tools/streaks.mjs');
  assert.equal(zorro.coreToolName, 'streaks.mjs');
  assert.equal(selfEditConfigForAgent({ agentId: 'digit', workspaceDir: '/w/d' }), null);
  assert.equal(selfEditConfigForAgent({ agentId: 'pitzi', workspaceDir: '/w/p' }), null);
  assert.equal(selfEditConfigForAgent(null), null);
});

test('readJsonSafe: parses valid, null on missing/garbage', () => {
  const ws = makeWorkspace();
  const good = join(ws, 'g.json'); writeFileSync(good, '{"a":1}');
  const bad = join(ws, 'b.json'); writeFileSync(bad, 'not json');
  assert.deepEqual(readJsonSafe(good), { a: 1 });
  assert.equal(readJsonSafe(bad), null);
  assert.equal(readJsonSafe(join(ws, 'missing.json')), null);
  rmSync(ws, { recursive: true, force: true });
});

// ───────────────────────────── engine (direct, no subprocess) ──────────────────────────────────

test('engine snapshot → revert restores an existing file byte-for-byte', () => {
  const ws = makeWorkspace();
  const se = createSelfEdit(baseCfg(ws));
  const rel = 'skills/x/prompt.md';
  const abs = join(ws, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'ORIGINAL');

  const snap = se.snapshot(JSON.stringify([rel]));
  assert.equal(snap.ok, true);
  assert.match(snap.snapshot_id, /^\d{8}-\d{6}-\w{4}$/);
  assert.deepEqual(snap.files, [{ path: rel, existed: true }]);

  writeFileSync(abs, 'BROKEN');
  const rev = se.revert(snap.snapshot_id);
  assert.equal(rev.ok, true);
  assert.deepEqual(rev.reverted, [{ path: rel, action: 'restored' }]);
  assert.equal(readFileSync(abs, 'utf8'), 'ORIGINAL');
  rmSync(ws, { recursive: true, force: true });
});

test('engine snapshot of a non-existing file → revert deletes it (restores absent)', () => {
  const ws = makeWorkspace();
  const se = createSelfEdit(baseCfg(ws));
  const rel = 'data/new-feature.md';
  const abs = join(ws, rel);
  const snap = se.snapshot(JSON.stringify([rel]));
  assert.deepEqual(snap.files, [{ path: rel, existed: false }]);

  writeFileSync(abs, 'created by the edit');
  assert.equal(existsSync(abs), true);
  const rev = se.revert(snap.snapshot_id);
  assert.deepEqual(rev.reverted, [{ path: rel, action: 'deleted (was new)' }]);
  assert.equal(existsSync(abs), false);
  rmSync(ws, { recursive: true, force: true });
});

test('engine snapshot rejects bad args + revert of unknown id', () => {
  const ws = makeWorkspace();
  const se = createSelfEdit(baseCfg(ws));
  assert.equal(se.snapshot('not-json').ok, false);
  assert.equal(se.snapshot(JSON.stringify({ not: 'array' })).ok, false);
  assert.equal(se.snapshot(JSON.stringify([])).ok, false);
  const rev = se.revert('nope');
  assert.equal(rev.ok, false);
  assert.match(rev.error, /no such snapshot/);
  assert.equal(se.revert().ok, false);
  rmSync(ws, { recursive: true, force: true });
});

test('engine log → changelog roundtrip; empty trail → []', () => {
  const ws = makeWorkspace();
  const se = createSelfEdit(baseCfg(ws));
  assert.deepEqual(se.changelog(), { ok: true, entries: [] });
  const logged = se.log(JSON.stringify({ summary: 'hello', files: ['a.md'] }));
  assert.equal(logged.ok, true);
  assert.ok(logged.logged.ts);
  assert.equal(logged.logged.summary, 'hello');
  const cl = se.changelog('5');
  assert.equal(cl.entries.length, 1);
  assert.equal(cl.entries[0].summary, 'hello');
  assert.equal(se.log('garbage').ok, false);
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify: passing tests + guarded JSON ok → ok:true exitCode 0', () => {
  const ws = makeWorkspace({ tests: 'pass', guarded: { '.config/bot.json': '{"valid":true}' } });
  const se = createSelfEdit(baseCfg(ws, { guardedJson: ['.config/bot.json'] }));
  const r = se.verify(false);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.ok(r.checks.some((c) => c.name === 'unit-tests' && c.ok));
  assert.ok(r.checks.some((c) => c.name === 'syntax:tools' && c.ok));
  assert.ok(r.checks.some((c) => c.name === 'json:.config/bot.json' && c.ok));
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify: failing unit tests → ok:false exitCode 2', () => {
  const ws = makeWorkspace({ tests: 'fail' });
  const se = createSelfEdit(baseCfg(ws));
  const r = se.verify(false);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.ok(r.checks.some((c) => c.name === 'unit-tests' && !c.ok));
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify: invalid guarded JSON → ok:false', () => {
  const ws = makeWorkspace({ tests: 'pass', guarded: { '.config/bot.json': 'NOT JSON' } });
  const se = createSelfEdit(baseCfg(ws, { guardedJson: ['.config/bot.json'] }));
  const r = se.verify(false);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === 'json:.config/bot.json' && !c.ok));
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify --tests-only: skips syntax + json checks', () => {
  const ws = makeWorkspace({ tests: 'pass', guarded: { '.config/bot.json': 'NOT JSON' } });
  const se = createSelfEdit(baseCfg(ws, { guardedJson: ['.config/bot.json'] }));
  const r = se.verify(true);
  assert.equal(r.ok, true); // bad JSON is NOT checked under --tests-only
  assert.ok(!r.checks.some((c) => c.name.startsWith('json:')));
  assert.ok(!r.checks.some((c) => c.name.startsWith('syntax:')));
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify (zorro): no test files → unit-tests skipped ok', () => {
  const ws = makeWorkspace(); // no test files written
  const se = createSelfEdit(baseCfg(ws));
  const r = se.verify(false);
  const ut = r.checks.find((c) => c.name === 'unit-tests');
  assert.equal(ut.ok, true);
  assert.match(ut.detail, /no test files found/);
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify (zorro): core-tool present → parses; runs even under --tests-only', () => {
  const ws = makeWorkspace({ tests: 'pass', coreTool: 'streaks.mjs' });
  const se = createSelfEdit(baseCfg(ws, { coreTool: join(ws, 'tools', 'streaks.mjs'), coreToolName: 'streaks.mjs' }));
  const full = se.verify(false);
  assert.ok(full.checks.some((c) => c.name === 'core-tool:streaks.mjs' && c.ok && c.detail === 'parses'));
  const testsOnly = se.verify(true);
  assert.ok(testsOnly.checks.some((c) => c.name === 'core-tool:streaks.mjs' && c.ok), 'core-tool runs under --tests-only too');
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify (zorro): core-tool absent → skipped ok', () => {
  const ws = makeWorkspace({ tests: 'pass' }); // no streaks.mjs
  const se = createSelfEdit(baseCfg(ws, { coreTool: join(ws, 'tools', 'streaks.mjs'), coreToolName: 'streaks.mjs' }));
  const r = se.verify(false);
  const c = r.checks.find((x) => x.name === 'core-tool:streaks.mjs');
  assert.equal(c.ok, true);
  assert.match(c.detail, /absent — skipped/);
  rmSync(ws, { recursive: true, force: true });
});

test('engine verify (zorro): broken core-tool → ok:false', () => {
  const ws = makeWorkspace({ tests: 'pass' });
  writeFileSync(join(ws, 'tools', 'streaks.mjs'), 'this is ((( not valid js');
  const se = createSelfEdit(baseCfg(ws, { coreTool: join(ws, 'tools', 'streaks.mjs'), coreToolName: 'streaks.mjs' }));
  const r = se.verify(false);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === 'core-tool:streaks.mjs' && !c.ok));
  rmSync(ws, { recursive: true, force: true });
});

// ───────────────────────────── CLI runner (subprocess, exit codes) ─────────────────────────────

test('CLI snapshot → revert restores (end-to-end, exit 0)', () => {
  const ws = makeWorkspace();
  const cfg = baseCfg(ws);
  const rel = 'skills/x/p.md';
  const abs = join(ws, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'ORIG');
  const snap = runCli(cfg, ['snapshot', JSON.stringify([rel])]);
  assert.equal(snap.ok, true);
  writeFileSync(abs, 'BROKEN');
  const rev = runCli(cfg, ['revert', snap.snapshot_id]);
  assert.equal(rev.ok, true);
  assert.equal(readFileSync(abs, 'utf8'), 'ORIG');
  rmSync(ws, { recursive: true, force: true });
});

test('CLI snapshot refuses path outside workspace (exit 1)', () => {
  const ws = makeWorkspace();
  const r = runCliExpectExit(baseCfg(ws), ['snapshot', JSON.stringify(['/etc/hosts'])]);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /outside the workspace/);
  rmSync(ws, { recursive: true, force: true });
});

test('CLI log → changelog reads it back', () => {
  const ws = makeWorkspace();
  const cfg = baseCfg(ws);
  const summary = `entry-${Math.random().toString(36).slice(2, 8)}`;
  const logged = runCli(cfg, ['log', JSON.stringify({ summary, files: ['x'] })]);
  assert.equal(logged.ok, true);
  assert.ok(logged.logged.ts);
  const cl = runCli(cfg, ['changelog', '50']);
  assert.ok(cl.entries.some((e) => e.summary === summary));
  rmSync(ws, { recursive: true, force: true });
});

test('CLI verify --tests-only reports ok shape (exit 0 with passing tests)', () => {
  const ws = makeWorkspace({ tests: 'pass' });
  const r = runCli(baseCfg(ws), ['verify', '--tests-only']);
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.checks));
  assert.ok(r.checks.some((c) => c.name === 'unit-tests'));
  rmSync(ws, { recursive: true, force: true });
});

test('CLI verify with failing tests exits 2', () => {
  const ws = makeWorkspace({ tests: 'fail' });
  const r = runCliExpectExit(baseCfg(ws), ['verify']);
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).ok, false);
  rmSync(ws, { recursive: true, force: true });
});

test('CLI unknown command fails cleanly (exit 1)', () => {
  const ws = makeWorkspace();
  const r = runCliExpectExit(baseCfg(ws), ['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.stdout.trim()).error, /unknown command/);
  rmSync(ws, { recursive: true, force: true });
});

test('selfEditConfigForAgent: registry selfEdit block overrides the legacy switch (6th bot needs no code)', () => {
  const rec = {
    agentId: 'newbot', workspaceDir: '/w/newbot',
    selfEdit: { guardedJson: ['.config/bot.json'], coreTool: 'tools/core.mjs' },
  };
  const cfg = selfEditConfigForAgent(rec);
  assert.deepEqual(cfg.guardedJson, ['.config/bot.json']);
  assert.equal(cfg.coreTool, '/w/newbot/tools/core.mjs');
  assert.equal(cfg.coreToolName, 'core.mjs');
  // digit still null WITHOUT a registry block (no harness wired)
  assert.equal(selfEditConfigForAgent({ agentId: 'digit', workspaceDir: '/w/d' }), null);
});
