#!/usr/bin/env node
// shared/tools/group-id.mjs
//
// Tiny, read-only CLI that prints an agent's resolved WhatsApp group JID(s) from the central
// registry (shared/registry.json via shared/lib/agent-registry.mjs). It exists so agent prompts
// have ONE stable command to obtain a send target instead of brittle inline
// `node -e "require('./.config/....json').whatsapp.group_id"` reads — those config fields were
// deleted 2026-07-17 when the registry became the single source of truth for all WhatsApp wiring.
//
// USAGE
//   node shared/tools/group-id.mjs <agentId> [primary|all]
//
//   <agentId>    REQUIRED. e.g. main | digit | poker | pitzi | zorro. Resolves via getAgent(id).
//   primary      (default) print the agent's PRIMARY group JID on one line.
//   all          print EVERY answering group JID the agent serves, one per line (digit has 2).
//
// It performs NO sends and NO writes — a pure lookup. Absolute path safe: it resolves the registry
// via the lib's own module location, so it prints the same value from any cwd.
//
// EXIT CODES
//   0  success (a JID was printed to stdout)
//   1  the agent resolved but has NO group (e.g. the silent `listener`) — nothing to print
//   2  usage error / unknown agentId / bad mode
//
// EXAMPLES
//   node shared/tools/group-id.mjs main          -> 1203630000000000XX@g.us
//   node shared/tools/group-id.mjs digit all     -> <digit-main jid>\n<digit-dy jid>

import { getAgent } from '../lib/agent-registry.mjs';

const USAGE = 'usage: group-id.mjs <agentId> [primary|all]';

/**
 * @param {string[]} argv                the CLI args (process.argv.slice(2))
 * @param {object}   [deps]              injectable seams for testing
 * @param {Function} [deps.getAgent]     (id) -> record|null
 * @param {object}   [deps.out]          { write } stdout sink (default process.stdout)
 * @param {object}   [deps.err]          { error } stderr sink (default console)
 * @returns {number} process exit code (0 ok / 1 agent has no group / 2 usage/unknown)
 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const _getAgent = deps.getAgent || getAgent;
  const out = deps.out || process.stdout;
  const err = deps.err || console;

  const agentId = argv[0];
  const mode = argv[1] || 'primary';

  if (!agentId || agentId.startsWith('--')) {
    err.error(USAGE);
    return 2;
  }
  if (mode !== 'primary' && mode !== 'all') {
    err.error(`${USAGE}\n  unknown mode: ${mode} (expected "primary" or "all")`);
    return 2;
  }

  const record = _getAgent(agentId);
  if (!record) {
    // Distinguish a RETIRED agent from a genuinely-unknown one: getAgent hides archived agents by
    // default, so a lookup with {includeArchived:true} tells us which message to print. Either way a
    // non-zero exit — an archived agent has no active send target.
    const archived = _getAgent(agentId, { includeArchived: true });
    if (archived) {
      err.error(`agent ${agentId} is archived (retired) — no active group to send to`);
      return 2;
    }
    err.error(`unknown agentId: ${agentId}`);
    return 2;
  }

  if (mode === 'all') {
    const ids = record.groupIds || [];
    if (!ids.length) {
      err.error(`agent ${agentId} has no groups in the registry`);
      return 1;
    }
    out.write(ids.join('\n') + '\n');
    return 0;
  }

  // mode === 'primary'
  const jid = record.primaryGroupId;
  if (!jid) {
    err.error(`agent ${agentId} has no primary group in the registry`);
    return 1;
  }
  out.write(jid + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
