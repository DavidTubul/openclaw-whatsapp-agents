// shared/lib/self-edit.mjs — UNIFIED, parameterized owner-gated self-improvement engine.
//
// Factors the three duplicated `workspace-*/tools/self-edit.mjs` copies (jobscout / poker /
// quitsmoke) into ONE engine, parameterized by an agent record. Behavior is preserved EXACTLY
// for each bot; the only differences between the copies were data, never logic:
//   • GUARDED_JSON list   — jobscout: .config/people.json + .config/job-scout.json
//                           poker/zorro: .config/bot.json
//   • a CORE_TOOL parse-check (zorro only: tools/streaks.mjs, skipped gracefully when absent)
//   • the "no test files found → skip" branch (zorro only — jobscout/poker always had tests)
//   • readJsonSafe came from tools/lib/cli.mjs (jobscout) vs inlined (poker/zorro) — same behavior.
//
// The DANGEROUS parts of a chat-driven self-edit — backing up before an edit, running the test
// suite, and reverting on failure — are pulled OUT of the LLM and made deterministic here, so a
// bad self-edit can never silently break a bot's cron / ledger / streak tracker.
//
// Flow the agent follows (see each skill's prompt-self-extend.md):
//   1. self-edit snapshot '["skills/<skill>/prompt-qa.md", ...]'   -> {snapshot_id}
//   2. (agent edits the files)
//   3. self-edit verify                                            -> {ok, checks}
//   4a. ok    -> self-edit log '{"summary":"...","files":[...],"snapshot_id":"..."}'
//   4b. !ok   -> self-edit revert <snapshot_id>                     -> restored, report failure
//
// Subcommands (preserved exactly):
//   snapshot '<json array of file paths>'   (paths abs or relative to workspace)
//   verify [--tests-only]
//   revert <snapshot_id>
//   log '<json entry>'
//   changelog [N]                            (show last N entries, default 15)
//
// snapshot/revert is plain file copy — deterministic and independent of git state (the repo IS
// on git/GitHub now, but bots must never depend on a clean working tree).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// cfg shape (the thin per-bot CLI wrapper builds it — usually from shared/lib/agent-registry.mjs —
// and passes it in; the engine itself reads no registry and resolves no agent):
// {
//   workspaceDir: "<abs>/workspace-<domain>",   // the bot's home; snapshot refuses paths outside it
//   toolsDir:     "<abs>/workspace-<domain>/tools",  // cwd for subprocesses + where *.mjs/*.test.mjs live
//   selfEditDir:  "<abs>/.../data/self-edit",   // audit trail (snapshots + changelog). Honour SELF_EDIT_DIR.
//   guardedJson:  ["...rel-to-workspace..."],   // config files that must stay valid JSON after an edit
//   coreTool:     "<abs>/tools/streaks.mjs" | null,  // OPTIONAL extra parse-check (zorro). null = none.
//   coreToolName: "streaks.mjs",                // OPTIONAL label for the core-tool check (defaults to basename)
// }
// ───────────────────────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync,
  rmSync, appendFileSync, readdirSync,
} from 'node:fs';
import { dirname, resolve, relative, join, isAbsolute, basename } from 'node:path';
import { stampInTz } from './time.mjs';

// Read+parse JSON, null on any error. (Was tools/lib/cli.mjs in jobscout, inlined in poker/zorro —
// identical behavior either way.)
export function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ───────────────────────────── pure helpers (unit-testable, no side effects) ─────────────────────

// Normalize a user-supplied path to { abs, rel } where rel is relative to workspaceDir.
// Rejects anything outside the workspace — the agent must never snapshot/edit infra.
export function resolveInWorkspace(workspaceDir, p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceDir, p);
  const rel = relative(workspaceDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path is outside the workspace (refused): ${p}`);
  }
  return { abs, rel };
}

export function newSnapshotId(now = new Date(), rand = Math.random) {
  // Wall-clock stamp in Israel time via the shared helper. This was hand-rolled with host-local
  // getFullYear/getHours/... — and the host TZ is Etc/UTC, so the stamp used to read in UTC. The
  // switch to Asia/Jerusalem is INTENDED: snapshot ids now read in the same timezone as everything
  // else the bots stamp (session-hygiene backups, chat logs), removing a 2–3h reading skew.
  const stamp = stampInTz(now);
  // a short random suffix avoids a collision if two snapshots land in the same second
  const suffix = rand().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

// ───────────────────────────── cfg normalization ─────────────────────────────────────────────────

// Build a complete cfg from a partial one. selfEditDir defaults to <ws>/data/self-edit unless the
// SELF_EDIT_DIR env var is set (production leaves it unset → real audit trail; tests isolate it).
export function normalizeSelfEditCfg(cfg = {}, env = process.env) {
  const workspaceDir = cfg.workspaceDir;
  if (!workspaceDir) throw new Error('self-edit cfg needs workspaceDir');
  const toolsDir = cfg.toolsDir || join(workspaceDir, 'tools');
  const selfEditDir = cfg.selfEditDir || env.SELF_EDIT_DIR || join(workspaceDir, 'data', 'self-edit');
  return {
    workspaceDir,
    toolsDir,
    selfEditDir,
    snapDir: join(selfEditDir, 'snapshots'),
    changelog: join(selfEditDir, 'changelog.jsonl'),
    guardedJson: Array.isArray(cfg.guardedJson) ? cfg.guardedJson.slice() : [],
    coreTool: cfg.coreTool || null,
    coreToolName: cfg.coreToolName || (cfg.coreTool ? basename(cfg.coreTool) : null),
  };
}

// Per-agent self-edit config (the guarded-JSON list + optional core tool) — the ONLY thing that
// differs between bots. Derived ENTIRELY from the agent-registry record's optional `selfEdit` block
// (shared/registry.json). main/poker/zorro carry one; agents without a `selfEdit` block (digit /
// pitzi) have no self-edit harness and get null so a caller can refuse cleanly. The old hardcoded
// `switch (rec.agentId)` was removed 2026-07-17 — the registry `selfEdit` blocks reproduce its
// output EXACTLY (main: people.json+job-scout.json; poker: bot.json; zorro: bot.json + streaks.mjs).
export function selfEditConfigForAgent(rec) {
  if (!rec || !rec.selfEdit) return null;
  const ws = rec.workspaceDir;
  const se = rec.selfEdit;
  const out = { workspaceDir: ws, guardedJson: se.guardedJson || [] };
  if (se.coreTool) {
    out.coreTool = join(ws, se.coreTool);
    out.coreToolName = basename(se.coreTool);
  }
  return out;
}

// ───────────────────────────── file listing helpers ──────────────────────────────────────────────

function listMjs(toolsDir) {
  const root = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs')).map((f) => join(toolsDir, f));
  const libDir = join(toolsDir, 'lib');
  const lib = existsSync(libDir)
    ? readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => join(libDir, f))
    : [];
  return [...root, ...lib];
}
function listTestFiles(toolsDir) {
  // Cover BOTH tools/*.test.mjs and tools/lib/*.test.mjs — the safety net is only as strong as the
  // tests it runs.
  const root = readdirSync(toolsDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(toolsDir, f));
  const libDir = join(toolsDir, 'lib');
  const libTests = existsSync(libDir)
    ? readdirSync(libDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(libDir, f))
    : [];
  return [...root, ...libTests];
}

// ───────────────────────────── the engine ────────────────────────────────────────────────────────

// createSelfEdit(cfg) -> { snapshot, verify, revert, log, changelog }
// Each method returns a plain result object: { ok, ... } (and for verify, an `exitCode`). The methods
// are side-effectful (fs) but DO NOT print or exit — the CLI runner below handles stdout + exit codes,
// so the engine is unit-testable without spawning a process.
export function createSelfEdit(rawCfg) {
  const cfg = normalizeSelfEditCfg(rawCfg);

  function snapshot(rawPaths) {
    let paths;
    try { paths = JSON.parse(rawPaths); } catch { return { ok: false, error: 'snapshot needs a JSON array of file paths' }; }
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'snapshot needs a non-empty JSON array of file paths' };
    }

    const id = newSnapshotId();
    const dir = join(cfg.snapDir, id);
    const files = [];
    for (const p of paths) {
      const { abs, rel } = resolveInWorkspace(cfg.workspaceDir, String(p)); // throws → caught by runner
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
    return { ok: true, snapshot_id: id, files };
  }

  // Each check is { name, ok, detail }. verify is OFFLINE and deterministic — it never hits the
  // network, so it's safe to run on every self-edit regardless of capability.
  function verify(testsOnly) {
    const checks = [];

    // 1. The unit test suite — the core safety net.
    // SELF_EDIT_VERIFYING tells the self-edit test's own verify-test to skip, so a verify
    // (which runs the suite, which includes that test) can't re-enter verify recursively.
    const testFiles = listTestFiles(cfg.toolsDir);
    if (testFiles.length === 0) {
      // zorro behavior: a workspace whose tools were built in parallel may have no tests yet.
      checks.push({ name: 'unit-tests', ok: true, detail: 'no test files found — skipped' });
    } else {
      try {
        // NODE_TEST_CONTEXT is scrubbed so the inner `node --test` reports its own real exit code
        // even when verify is itself invoked from within a node --test run. In production this var
        // is never set, so this is a no-op for the bots — it only fixes nested-test verification.
        const verifyEnv = { ...process.env, SELF_EDIT_VERIFYING: '1' };
        delete verifyEnv.NODE_TEST_CONTEXT;
        execFileSync('node', ['--test', ...testFiles], {
          cwd: cfg.toolsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
          env: verifyEnv,
        });
        checks.push({ name: 'unit-tests', ok: true, detail: 'all passed' });
      } catch (e) {
        const tail = String(e.stdout || e.stderr || e.message).split('\n').slice(-25).join('\n');
        checks.push({ name: 'unit-tests', ok: false, detail: tail });
      }
    }

    // 2. (zorro only) Sanity-check the core tool parses — IF configured AND present. Runs BEFORE the
    //    syntax sweep and regardless of --tests-only, matching the original zorro ordering exactly.
    if (cfg.coreTool) {
      const label = `core-tool:${cfg.coreToolName}`;
      if (existsSync(cfg.coreTool)) {
        try {
          execFileSync('node', ['--check', cfg.coreTool], { cwd: cfg.toolsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
          checks.push({ name: label, ok: true, detail: 'parses' });
        } catch (e) {
          checks.push({ name: label, ok: false, detail: String(e.stderr || e.message).split('\n').slice(-6).join('\n') });
        }
      } else {
        checks.push({ name: label, ok: true, detail: 'absent — skipped' });
      }
    }

    if (!testsOnly) {
      // 3. Syntax-check every tool .mjs (catches a broken edit to tool code).
      for (const f of listMjs(cfg.toolsDir)) {
        try {
          execFileSync('node', ['--check', f], { cwd: cfg.toolsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
        } catch (e) {
          checks.push({ name: `syntax:${relative(cfg.toolsDir, f)}`, ok: false, detail: String(e.stderr || e.message).split('\n').slice(-6).join('\n') });
        }
      }
      if (!checks.some((c) => c.name.startsWith('syntax:'))) checks.push({ name: 'syntax:tools', ok: true, detail: 'all .mjs parse' });

      // 4. Guarded config files must stay valid JSON.
      for (const rel of cfg.guardedJson) {
        const abs = join(cfg.workspaceDir, rel);
        if (!existsSync(abs)) continue;
        try { JSON.parse(readFileSync(abs, 'utf8')); checks.push({ name: `json:${rel}`, ok: true, detail: 'valid' }); }
        catch (e) { checks.push({ name: `json:${rel}`, ok: false, detail: e.message }); }
      }
    }

    const ok = checks.every((c) => c.ok);
    // verify's exit contract: ok → 0, !ok → 2 (preserved from all three copies).
    return { ok, checks, exitCode: ok ? 0 : 2 };
  }

  function revert(id) {
    if (!id) return { ok: false, error: 'revert needs a snapshot_id' };
    const dir = join(cfg.snapDir, id);
    const manifest = readJsonSafe(join(dir, 'manifest.json'));
    if (!manifest) return { ok: false, error: `no such snapshot: ${id}` };
    const reverted = [];
    for (const f of manifest.files) {
      const abs = join(cfg.workspaceDir, f.path);
      if (f.existed) {
        const src = join(dir, f.path);
        if (existsSync(src)) { mkdirSync(dirname(abs), { recursive: true }); copyFileSync(src, abs); reverted.push({ path: f.path, action: 'restored' }); }
      } else {
        // file did not exist at snapshot time → the edit created it → delete it.
        if (existsSync(abs)) { rmSync(abs); reverted.push({ path: f.path, action: 'deleted (was new)' }); }
      }
    }
    return { ok: true, snapshot_id: id, reverted };
  }

  function log(rawEntry) {
    let entry;
    try { entry = JSON.parse(rawEntry); } catch { return { ok: false, error: 'log needs a JSON object' }; }
    mkdirSync(cfg.selfEditDir, { recursive: true });
    const record = { ts: new Date().toISOString(), ...entry };
    appendFileSync(cfg.changelog, JSON.stringify(record) + '\n');
    return { ok: true, logged: record };
  }

  function changelog(nRaw) {
    const n = Math.max(1, Number(nRaw) || 15);
    if (!existsSync(cfg.changelog)) return { ok: true, entries: [] };
    const lines = readFileSync(cfg.changelog, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const entries = lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    return { ok: true, entries };
  }

  return { cfg, snapshot, verify, revert, log, changelog };
}

// ───────────────────────────── CLI runner ────────────────────────────────────────────────────────

// runCli(cfg, argv) — the thin command dispatcher the per-bot wrapper calls. Prints exactly one JSON
// line to stdout and exits with the preserved codes: fail → 1, verify-not-ok → 2, success → 0.
// (Matches the original standalone scripts' stdout + process.exit contract.)
export function runCli(rawCfg, argv = process.argv.slice(2)) {
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const fail = (msg, extra = {}) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(msg?.message ?? msg), ...extra }) + '\n');
    process.exit(1);
  };

  let engine;
  try { engine = createSelfEdit(rawCfg); } catch (e) { return fail(e); }

  const [cmd, arg] = argv;
  try {
    switch (cmd) {
      case 'snapshot': {
        const r = engine.snapshot(arg);
        if (!r.ok) return fail(r.error);
        return out(r);
      }
      case 'verify': {
        const r = engine.verify(argv.includes('--tests-only'));
        out({ ok: r.ok, checks: r.checks });
        if (!r.ok) process.exit(2);
        return;
      }
      case 'revert': {
        const r = engine.revert(arg);
        if (!r.ok) return fail(r.error);
        return out(r);
      }
      case 'log': {
        const r = engine.log(arg);
        if (!r.ok) return fail(r.error);
        return out(r);
      }
      case 'changelog': {
        return out(engine.changelog(arg));
      }
      default:
        return fail(`unknown command "${cmd || ''}". Use: snapshot | verify | revert | log | changelog`);
    }
  } catch (e) { fail(e); }
}
