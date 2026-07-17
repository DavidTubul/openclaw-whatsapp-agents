#!/usr/bin/env node
// shared/bin/self-edit.mjs — generic CLI entry for the unified self-edit engine.
//
// Resolves the per-agent self-edit cfg from the central registry and dispatches the subcommand.
// The thin per-bot wrapper that ships in each workspace is just:
//
//     #!/usr/bin/env node
//     import { runForAgent } from '../../shared/bin/self-edit.mjs';
//     runForAgent('zorro');   // or 'main' / 'poker'
//
// or, for a fully data-driven launcher, pass the agent id via SELF_EDIT_AGENT / --agent:
//     node shared/bin/self-edit.mjs --agent zorro verify
//
// SELF_EDIT_DIR env still isolates the audit trail (honored by normalizeSelfEditCfg), preserving the
// test-isolation contract of all three original scripts.

import { createSelfEdit, runCli, selfEditConfigForAgent } from '../lib/self-edit.mjs';
import { getAgent } from '../lib/agent-registry.mjs';

// Resolve { cfg, argv } for an agent id, returning a self-edit config from the registry record.
export function cfgForAgent(agentId) {
  const rec = getAgent(agentId);
  if (!rec) throw new Error(`unknown agent: ${agentId}`);
  const cfg = selfEditConfigForAgent(rec);
  if (!cfg) throw new Error(`agent "${agentId}" has no self-edit harness wired`);
  return cfg;
}

// runForAgent(agentId, argv?) — the entry a per-bot wrapper calls. Emits a clean {ok:false,error}
// line + exit 1 for an unknown / unwired agent (matching the engine's stdout contract) instead of
// throwing a raw stack trace.
export function runForAgent(agentId, argv = process.argv.slice(2)) {
  let cfg;
  try { cfg = cfgForAgent(agentId); }
  catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + '\n');
    process.exit(1);
  }
  runCli(cfg, argv);
}

// Direct invocation: `node self-edit.mjs --agent <id> <cmd> ...` (or SELF_EDIT_AGENT env).
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let agentId = process.env.SELF_EDIT_AGENT;
  const i = argv.indexOf('--agent');
  if (i !== -1) { agentId = argv[i + 1]; argv.splice(i, 2); }
  if (!agentId) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no agent: pass --agent <id> or set SELF_EDIT_AGENT' }) + '\n');
    process.exit(1);
  }
  runForAgent(agentId, argv);
}

// re-export the engine pieces so callers can build a cfg by hand too.
export { createSelfEdit, runCli, selfEditConfigForAgent };
