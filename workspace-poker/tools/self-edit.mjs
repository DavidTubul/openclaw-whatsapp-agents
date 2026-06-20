#!/usr/bin/env node
// Deterministic safety harness for דאוס's chat-driven self-extension.
//
// The conversational agent (Sonnet, single live turn, no review) plans and edits
// its own prompt/skill/tool files. The DANGEROUS parts — backing up before an edit,
// running the test suite, and reverting on failure — are pulled OUT of the LLM and
// made deterministic here, so a bad self-edit can never silently break the poker
// ledger (poker.mjs) or the session-hygiene timer.
//
// Flow the agent follows (see skills/poker-buddy/prompt-self-extend.md):
//   1. node self-edit.mjs snapshot '["skills/poker-buddy/prompt-qa.md", ...]'  -> {snapshot_id}
//   2. (agent edits the files)
//   3. node self-edit.mjs verify                                               -> {ok, checks}
//   4a. ok    -> node self-edit.mjs log '{"summary":"...","files":[...],"snapshot_id":"..."}'
//   4b. !ok   -> node self-edit.mjs revert <snapshot_id>                        -> restored, report failure
//
// Usage:
//   node self-edit.mjs snapshot '<json array of file paths>'   (paths abs or relative to workspace)
//   node self-edit.mjs verify [--tests-only]
//   node self-edit.mjs revert <snapshot_id>
//   node self-edit.mjs log '<json entry>'
//   node self-edit.mjs changelog [N]        (show last N entries, default 15)
//
// This repo is NOT a git repo, so snapshot/revert is plain file copy — never relies on git.
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync,
  rmSync, appendFileSync, readdirSync,
} from 'node:fs';
import { dirname, resolve, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inlined (the poker workspace has no tools/lib/cli.mjs): read+parse JSON, null on any error.
function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));        // .../workspace-poker/tools
const WORKSPACE = resolve(TOOLS_DIR, '..');                       // .../workspace-poker
// SELF_EDIT_DIR lets the test suite isolate snapshots/changelog into a temp dir so it
// never pollutes the real audit trail. Production leaves it unset → data/self-edit.
const SELF_DIR = process.env.SELF_EDIT_DIR || join(WORKSPACE, 'data', 'self-edit');
const SNAP_DIR = join(SELF_DIR, 'snapshots');
const CHANGELOG = join(SELF_DIR, 'changelog.jsonl');

// Config files that must stay valid JSON after an edit. (Every tool .mjs is syntax-checked
// automatically.) data/players.json + data/sessions.json are managed by poker.mjs, never
// hand-edited, so they are intentionally NOT listed here.
const GUARDED_JSON = [
  '.config/bot.json',
];

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function fail(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(msg?.message ?? msg), ...extra }) + '\n');
  process.exit(1);
}

// Normalize a user-supplied path to { abs, rel } where rel is relative to WORKSPACE.
// Rejects anything outside the workspace — the agent must never snapshot/edit infra.
function resolveInWorkspace(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(WORKSPACE, p);
  const rel = relative(WORKSPACE, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path is outside the workspace (refused): ${p}`);
  }
  return { abs, rel };
}

function newSnapshotId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // a short random suffix avoids a collision if two snapshots land in the same second
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

// ---- commands ---------------------------------------------------------------

function cmdSnapshot(rawPaths) {
  let paths;
  try { paths = JSON.parse(rawPaths); } catch { return fail('snapshot needs a JSON array of file paths'); }
  if (!Array.isArray(paths) || paths.length === 0) return fail('snapshot needs a non-empty JSON array of file paths');

  const id = newSnapshotId();
  const dir = join(SNAP_DIR, id);
  const files = [];
  for (const p of paths) {
    const { abs, rel } = resolveInWorkspace(String(p));
    const existed = existsSync(abs);
    if (existed) {
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
    }
    // a file that does NOT exist yet is a NEW file the edit will create; record it so
    // revert deletes it (restores "absent").
    files.push({ path: rel, existed });
  }
  mkdirSync(dir, { recursive: true });
  const manifest = { id, created: new Date().toISOString(), files };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  out({ ok: true, snapshot_id: id, files });
}

// Each check is { name, ok, detail }. verify is OFFLINE and deterministic — it never
// hits the network, so it's safe to run on every self-edit regardless of capability.
function cmdVerify(testsOnly) {
  const checks = [];

  // 1. The unit test suite — the core safety net (poker ledger + session-hygiene).
  try {
    execFileSync('node', ['--test', ...listTestFiles()], {
      cwd: TOOLS_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      env: { ...process.env, SELF_EDIT_VERIFYING: '1' },
    });
    checks.push({ name: 'unit-tests', ok: true, detail: 'all passed' });
  } catch (e) {
    const tail = String(e.stdout || e.stderr || e.message).split('\n').slice(-25).join('\n');
    checks.push({ name: 'unit-tests', ok: false, detail: tail });
  }

  if (!testsOnly) {
    // 2. Syntax-check every tool .mjs (catches a broken edit to tool code).
    for (const f of listMjs()) {
      try {
        execFileSync('node', ['--check', f], { cwd: TOOLS_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      } catch (e) {
        checks.push({ name: `syntax:${relative(TOOLS_DIR, f)}`, ok: false, detail: String(e.stderr || e.message).split('\n').slice(-6).join('\n') });
      }
    }
    if (!checks.some((c) => c.name.startsWith('syntax:'))) checks.push({ name: 'syntax:tools', ok: true, detail: 'all .mjs parse' });

    // 3. Guarded config files must stay valid JSON.
    for (const rel of GUARDED_JSON) {
      const abs = join(WORKSPACE, rel);
      if (!existsSync(abs)) continue;
      try { JSON.parse(readFileSync(abs, 'utf8')); checks.push({ name: `json:${rel}`, ok: true, detail: 'valid' }); }
      catch (e) { checks.push({ name: `json:${rel}`, ok: false, detail: e.message }); }
    }
  }

  const ok = checks.every((c) => c.ok);
  out({ ok, checks });
  if (!ok) process.exit(2);
}

function cmdRevert(id) {
  if (!id) return fail('revert needs a snapshot_id');
  const dir = join(SNAP_DIR, id);
  const manifest = readJsonSafe(join(dir, 'manifest.json'));
  if (!manifest) return fail(`no such snapshot: ${id}`);
  const reverted = [];
  for (const f of manifest.files) {
    const abs = join(WORKSPACE, f.path);
    if (f.existed) {
      const src = join(dir, f.path);
      if (existsSync(src)) { mkdirSync(dirname(abs), { recursive: true }); copyFileSync(src, abs); reverted.push({ path: f.path, action: 'restored' }); }
    } else {
      // file did not exist at snapshot time → the edit created it → delete it.
      if (existsSync(abs)) { rmSync(abs); reverted.push({ path: f.path, action: 'deleted (was new)' }); }
    }
  }
  out({ ok: true, snapshot_id: id, reverted });
}

function cmdLog(rawEntry) {
  let entry;
  try { entry = JSON.parse(rawEntry); } catch { return fail('log needs a JSON object'); }
  mkdirSync(SELF_DIR, { recursive: true });
  const record = { ts: new Date().toISOString(), ...entry };
  appendFileSync(CHANGELOG, JSON.stringify(record) + '\n');
  out({ ok: true, logged: record });
}

function cmdChangelog(nRaw) {
  const n = Math.max(1, Number(nRaw) || 15);
  if (!existsSync(CHANGELOG)) { out({ ok: true, entries: [] }); return; }
  const lines = readFileSync(CHANGELOG, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const entries = lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  out({ ok: true, entries });
}

// ---- helpers ----------------------------------------------------------------

function listMjs() {
  const root = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => join(TOOLS_DIR, f));
  const libDir = join(TOOLS_DIR, 'lib');
  const lib = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => join(libDir, f)) : [];
  return [...root, ...lib];
}
function listTestFiles() {
  // Cover BOTH tools/*.test.mjs (session-hygiene) and tools/lib/*.test.mjs (poker) — the
  // safety net is only as strong as the tests it runs.
  const root = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.test.mjs')).map((f) => join(TOOLS_DIR, f));
  const libDir = join(TOOLS_DIR, 'lib');
  const libTests = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(libDir, f)) : [];
  return [...root, ...libTests];
}

// ---- main -------------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'snapshot': cmdSnapshot(arg); break;
    case 'verify': cmdVerify(process.argv.includes('--tests-only')); break;
    case 'revert': cmdRevert(arg); break;
    case 'log': cmdLog(arg); break;
    case 'changelog': cmdChangelog(arg); break;
    default:
      fail(`unknown command "${cmd || ''}". Use: snapshot | verify | revert | log | changelog`);
  }
} catch (e) { fail(e); }
