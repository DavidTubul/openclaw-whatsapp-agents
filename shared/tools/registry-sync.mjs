#!/usr/bin/env node
// shared/tools/registry-sync.mjs
//
// Render / check the openclaw.json + cron views that are DERIVED from shared/registry.json (the v2
// single source of truth for WhatsApp wiring). All diffing logic is the pure, unit-tested
// shared/lib/registry-sync.mjs; this file is the I/O shell: it builds the model from the registry
// loader, reads openclaw.json, shells `openclaw cron list --json`, and prints/patches.
//
// USAGE:
//   node shared/tools/registry-sync.mjs            # --check (default): drift report, exit 1 if any drift
//   node shared/tools/registry-sync.mjs --check
//   node shared/tools/registry-sync.mjs --json     # machine-readable drift (for a future watchdog)
//   node shared/tools/registry-sync.mjs --apply     # backup + render openclaw.json + fix cron --to targets
//
// It NEVER restarts the gateway and NEVER touches credentials. --apply reminds you to restart the
// gateway (while chat is idle) only when openclaw.json actually changed.
//
// Overrides for testing / dry runs (no live gateway needed):
//   OPENCLAW_JSON=/path/to/openclaw.json         (default: ~/.openclaw/openclaw.json)
//   OPENCLAW_CRON_JSON=/path/to/cron-list.json   (read cron list from a file instead of shelling)

import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getGroups, listAgents, resolveGroupRef } from '../lib/agent-registry.mjs';
import { computeSync } from '../lib/registry-sync.mjs';
import { writeFileAtomic } from '../lib/fs-atomic.mjs';

// This file lives at <repo>/shared/tools/, so ../.. is the repo root — derived from the module URL
// (mirrors shared/lib/agent-registry.mjs / paths.mjs) so nothing is hardcoded to one machine.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOME = process.env.HOME || os.homedir();
const OPENCLAW_JSON = process.env.OPENCLAW_JSON || path.join(HOME, '.openclaw', 'openclaw.json');
const REGISTRY_JSON = path.join(REPO_ROOT, 'shared', 'registry.json');
const OPENCLAW_CLI = path.join(REPO_ROOT, 'openclaw');
const BACKUP_DIR = path.join(REPO_ROOT, 'shared', 'backups', 'registry-sync');
const KEEP_BACKUPS = 20;
const MAIN_AGENT_ID = 'main';

// ── build the pure-lib model from the registry loader ──
function buildModel() {
  // includeArchived so archived agents/groups are PRESENT-but-flagged: the diff layer detects their
  // leftover openclaw.json wiring and the patch removes it (see shared/lib/registry-sync.mjs header).
  const groups = Object.values(getGroups({ includeArchived: true }));
  const agents = listAgents({ includeListenOnly: true, includeArchived: true }).map((rec) => {
    const ct = rec.cronTargets || {};
    const cronTargetJids = {};
    for (const [job, sym] of Object.entries(ct)) {
      if (job === 'default') continue;
      const jid = resolveGroupRef(sym);
      if (jid) cronTargetJids[job] = jid;
    }
    const cronDefaultJid = resolveGroupRef(ct.default || rec.primaryGroup) || rec.primaryGroupId || undefined;
    return {
      agentId: rec.agentId,
      identityName: rec.identity.name,
      identityEmoji: rec.identity.emoji,
      mentionPatterns: rec.identity.mentionPatterns,
      workspaceAbs: rec.workspaceDir,
      groupJids: rec.groupIds,
      answering: !rec.listenerAgent,
      archived: !!rec.archived,
      cronTargetJids,
      cronDefaultJid,
    };
  });
  return { mainAgentId: MAIN_AGENT_ID, groups, agents };
}

function readConfig() {
  return JSON.parse(readFileSync(OPENCLAW_JSON, 'utf8'));
}

function readCronJobs() {
  if (process.env.OPENCLAW_CRON_JSON) {
    const parsed = JSON.parse(readFileSync(process.env.OPENCLAW_CRON_JSON, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.jobs || []);
  }
  const out = execFileSync(OPENCLAW_CLI, ['cron', 'list', '--json'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  // The CLI may print boot noise before the JSON; slice from the first '{'.
  const start = out.indexOf('{');
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  return parsed.jobs || [];
}

// ── backups ──
function backupFile(srcPath, stamp) {
  if (!existsSync(srcPath)) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const base = path.basename(srcPath, '.json');
  const dest = path.join(BACKUP_DIR, `${base}-${stamp}.json`);
  copyFileSync(srcPath, dest);
  // prune: keep the newest KEEP_BACKUPS for this basename prefix
  const prefix = `${base}-`;
  const mine = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort(); // timestamp names sort chronologically
  for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
    try { unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* best-effort */ }
  }
  return dest;
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── output ──
function printDrifts(drifts) {
  const byView = {};
  for (const d of drifts) (byView[d.view] ||= []).push(d);
  for (const view of ['groups', 'bindings', 'agents', 'cron']) {
    const items = byView[view];
    if (!items || !items.length) continue;
    console.log(`\n▶ ${view} (${items.length})`);
    for (const d of items) {
      console.log(`  • ${d.message}`);
      const exp = d.expected === undefined ? '(none)' : JSON.stringify(d.expected);
      const act = d.actual === undefined ? '(none)' : JSON.stringify(d.actual);
      console.log(`      path: ${d.path}`);
      console.log(`      expected: ${exp}`);
      console.log(`      actual:   ${act}`);
    }
  }
}

function summaryLine(n) {
  return n === 0 ? 'registry-sync: OK' : `registry-sync: ${n} drift(s)`;
}

// ── main ──
function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const applyMode = argv.includes('--apply');
  // --check is the default; explicit or implied.

  const model = buildModel();
  const config = readConfig();
  const cronJobs = readCronJobs();
  const result = computeSync({ model, config, cronJobs });

  if (jsonMode) {
    console.log(JSON.stringify({
      ok: result.drifts.length === 0,
      driftCount: result.drifts.length,
      changedConfig: result.changedConfig,
      drifts: result.drifts,
      cronEdits: result.cronEdits,
    }, null, 2));
    process.exit(result.drifts.length === 0 ? 0 : 1);
  }

  if (!applyMode) {
    // --check
    if (result.drifts.length === 0) {
      console.log(summaryLine(0));
      process.exit(0);
    }
    printDrifts(result.drifts);
    console.log(`\n${summaryLine(result.drifts.length)}`);
    process.exit(1);
  }

  // --apply
  if (result.drifts.length === 0) {
    console.log('registry-sync: already in sync — nothing to apply.');
    console.log(summaryLine(0));
    process.exit(0);
  }

  printDrifts(result.drifts);
  console.log(`\nApplying ${result.drifts.length} fix(es)…`);

  const stamp = stampNow();
  const cfgBak = backupFile(OPENCLAW_JSON, stamp);
  const regBak = backupFile(REGISTRY_JSON, stamp);
  if (cfgBak) console.log(`  backup: ${cfgBak}`);
  if (regBak) console.log(`  backup: ${regBak}`);

  if (result.changedConfig) {
    writeFileAtomic(OPENCLAW_JSON, JSON.stringify(result.patchedConfig, null, 2) + '\n');
    console.log(`  wrote: ${OPENCLAW_JSON}`);
  }

  for (const e of result.cronEdits) {
    try {
      execFileSync(OPENCLAW_CLI, ['cron', 'edit', e.id, '--to', e.to], {
        encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      });
      console.log(`  cron edit: ${e.name} -> ${e.to}`);
    } catch (err) {
      console.error(`  cron edit FAILED for ${e.name} (${e.id}): ${(err && err.message) || err}`);
    }
  }

  // re-check against fresh state
  const config2 = readConfig();
  const cron2 = readCronJobs();
  const after = computeSync({ model, config: config2, cronJobs: cron2 });
  console.log('');
  if (after.drifts.length) {
    printDrifts(after.drifts);
    console.log('');
  }
  console.log(summaryLine(after.drifts.length));
  if (result.changedConfig) {
    console.log('\n⚠️  openclaw.json changed — gateway restart required while chat is idle:');
    console.log('    openclaw gateway restart   (or: systemctl --user restart openclaw-gateway.service)');
  }
  process.exit(after.drifts.length === 0 ? 0 : 1);
}

main();
