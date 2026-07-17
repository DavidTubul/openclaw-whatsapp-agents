#!/usr/bin/env node
// THIN SHIM → shared/lib/session-hygiene.mjs (agentId "zorro"). All logic + wiring live in the shared
// lib (registry-driven, shared/registry.json); the shared suite (cd shared && node --test) tests it.
// systemd runs this with no --agent flag, so the agentId is fixed here.
import { getAgent } from '../../shared/lib/agent-registry.mjs';
import { runHygiene } from '../../shared/lib/session-hygiene.mjs';

const record = getAgent('zorro');
if (!record) { console.error('unknown agentId: zorro'); process.exit(2); }
runHygiene({
  record,
  dryRun: process.argv.includes('--dry-run'),
  forceReset: process.argv.includes('--force-reset'),
  forcePoisoned: process.argv.includes('--force-reset-poisoned'),
}).catch((e) => { console.error(`[session-hygiene-zorro] fatal: ${e?.message || e}`); process.exit(1); });
