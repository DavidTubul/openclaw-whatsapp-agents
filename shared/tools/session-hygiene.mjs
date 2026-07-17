#!/usr/bin/env node
// shared/tools/session-hygiene.mjs
//
// Thin, generic CLI wrapper around the unified session-hygiene LIB
// (shared/lib/session-hygiene.mjs). It does NO decision logic of its own — it parses argv,
// resolves the target agent record(s) from the central registry (shared/lib/agent-registry.mjs),
// and delegates each to runHygiene(). All the size-cap / idle-gated-daily / proactive-poison /
// force-reset behaviour, the per-bot notify text, and the side effects live in the lib and are
// preserved EXACTLY (the lib was factored verbatim out of the three byte-identical per-bot copies
// in workspace-jobscout/poker/quitsmoke). This wrapper is the per-agent (or systemd-unit) entry
// point that those three tools used to be — now one file, parameterized by --agent.
//
// USAGE
//   node session-hygiene.mjs --agent <id> [--dry-run|--force-reset|--force-reset-poisoned]
//   node session-hygiene.mjs --all       [--dry-run|--force-reset|--force-reset-poisoned]
//
//   --agent <id>   REQUIRED unless --all. Resolves via getAgent(id); unknown id -> exit 2.
//   --all          Run for EVERY agent that has a sessionHygiene block in the registry, in
//                  registry order. Mode flags apply to each. One agent failing never aborts the
//                  rest; the process exit code is non-zero iff any agent threw.
//   --dry-run               Decide + log, never reset (mirrors the per-bot tools' --dry-run).
//   --force-reset           Manual reset; still idle-gated (mirrors --force-reset).
//   --force-reset-poisoned  Watchdog recovery; bypasses the idle-gate ONLY when confirmed
//                           poisoned (mirrors --force-reset-poisoned).
//
// EXIT CODES (mirror the per-bot tools)
//   0  success (any non-throwing run, incl. disabled/no-session/noop/defer/reset)
//   1  a fatal error (the lib threw) — for --all, iff ANY agent threw
//   2  usage / unknown agent id
//
// The per-bot --dry-run/--force-reset/--force-reset-poisoned flags and the per-agent CLI shape
// (`<tool> [flags]`) are preserved; the only change is the agent is now named via --agent instead
// of being hard-coded into a per-workspace copy.

import { getAgent, listAgents } from '../lib/agent-registry.mjs';
import { runHygiene } from '../lib/session-hygiene.mjs';

const USAGE =
  'usage: session-hygiene.mjs (--agent <id> | --all) [--dry-run|--force-reset|--force-reset-poisoned]';

function parseArgs(argv) {
  const flags = {
    all: argv.includes('--all'),
    dryRun: argv.includes('--dry-run'),
    forceReset: argv.includes('--force-reset'),
    forcePoisoned: argv.includes('--force-reset-poisoned'),
    agent: undefined,
  };
  const i = argv.indexOf('--agent');
  if (i !== -1) flags.agent = argv[i + 1];
  return flags;
}

/**
 * @param {string[]} argv
 * @param {object}   [deps]   injectable seams for testing
 * @param {Function} [deps.getAgent]    (id) -> record|null
 * @param {Function} [deps.listAgents]  () -> record[]
 * @param {Function} [deps.runHygiene]  ({record,dryRun,forceReset,forcePoisoned}) -> Promise
 * @param {object}   [deps.logger]      { error } (default console)
 * @returns {Promise<number>} process exit code (0 ok / 1 a run threw / 2 usage/unknown)
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const _getAgent = deps.getAgent || getAgent;
  const _listAgents = deps.listAgents || listAgents;
  const _runHygiene = deps.runHygiene || runHygiene;
  const logger = deps.logger || console;
  const flags = parseArgs(argv);

  // Resolve the set of target records.
  let records;
  if (flags.all) {
    // Every agent that has a sessionHygiene block (the registry carries one per wired agent).
    records = _listAgents().filter((r) => r.sessionHygiene);
    if (!records.length) {
      logger.error('--all: no agents with a sessionHygiene block in the registry');
      return 2;
    }
  } else {
    if (!flags.agent || flags.agent.startsWith('--')) {
      logger.error(USAGE);
      return 2;
    }
    const record = _getAgent(flags.agent);
    if (!record) {
      logger.error(`unknown agentId: ${flags.agent}`);
      return 2;
    }
    records = [record];
  }

  // Delegate each to the lib. In --all mode, one agent failing never aborts the rest; the exit
  // code is non-zero iff any agent threw. Single-agent mode propagates the failure as exit 1.
  let anyError = false;
  for (const record of records) {
    try {
      await _runHygiene({
        record,
        dryRun: flags.dryRun,
        forceReset: flags.forceReset,
        forcePoisoned: flags.forcePoisoned,
      });
    } catch (e) {
      anyError = true;
      logger.error(`[session-hygiene-${record.agentId}] fatal: ${e?.message || e}`);
    }
  }
  return anyError ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[session-hygiene] fatal: ${e?.message || e}`);
      process.exit(1);
    });
}
