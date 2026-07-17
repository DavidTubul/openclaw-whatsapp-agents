#!/usr/bin/env node
// shared/tools/self-edit.mjs
//
// Thin, generic CLI wrapper around the unified self-edit ENGINE (shared/lib/self-edit.mjs),
// the agent-facing peer of shared/tools/session-hygiene.mjs. It does NO snapshot/verify/revert
// logic of its own — it parses argv for the required `--agent <id>`, resolves that agent's
// self-edit config from the central registry (shared/lib/agent-registry.mjs via the
// shared/bin/self-edit.mjs resolver), and delegates to the engine's CLI runner.
//
// All the dangerous, deterministic behaviour (snapshot → verify → revert-on-failure → log),
// the per-agent guarded-JSON list + optional core-tool parse-check, and — critically — the
// EXIT CODES are preserved EXACTLY by delegating to runForAgent()/runCli() in the lib. The lib
// was factored verbatim out of the three per-bot copies (jobscout / poker / quitsmoke); this
// wrapper is the per-agent entry point those tools used to be — now one file, parameterized by
// --agent instead of being hard-coded into a per-workspace copy.
//
// USAGE
//   node self-edit.mjs --agent <id> snapshot '<json array of file paths>'
//   node self-edit.mjs --agent <id> verify [--tests-only]
//   node self-edit.mjs --agent <id> revert <snapshot_id>
//   node self-edit.mjs --agent <id> log '<json entry>'
//   node self-edit.mjs --agent <id> changelog [N]
//
//   --agent <id>   REQUIRED. Resolved via getAgent(id) → selfEditConfigForAgent(record).
//                  Wired agents: main / poker / zorro. (digit / pitzi have no harness.)
//                  SELF_EDIT_AGENT env is honoured as a fallback when --agent is omitted.
//   SELF_EDIT_DIR  env still isolates the audit trail (honoured by the engine), preserving the
//                  test-isolation contract of all three original per-bot scripts.
//
// STDOUT / EXIT CODES (preserved verbatim from the original per-bot self-edit.mjs scripts):
//   • exactly one JSON line is written to stdout per invocation
//   • success                              → exit 0
//   • verify reported !ok                  → exit 2 ({ok:false,checks:[...]})
//   • any failure / usage / unknown-agent  → exit 1 ({ok:false,error:"..."})
//
// The subcommands (snapshot | verify | revert | log | changelog), the `verify --tests-only`
// flag, and the {ok,checks}/{ok,...} JSON shapes are unchanged; the ONLY difference from the
// per-workspace copies is that the agent is now named via --agent instead of being baked in.

import { runForAgent } from '../bin/self-edit.mjs';

// Parse + strip `--agent <id>` (falling back to SELF_EDIT_AGENT); leave the rest of argv
// (the subcommand + its args, including `--tests-only`) untouched for the engine's runCli.
export function parseAgent(argv, env = process.env) {
  const rest = argv.slice();
  let agent = env.SELF_EDIT_AGENT;
  const i = rest.indexOf('--agent');
  if (i !== -1) {
    agent = rest[i + 1];
    rest.splice(i, 2);
  }
  return { agent, rest };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { agent, rest } = parseAgent(argv, env);
  if (!agent || String(agent).startsWith('--')) {
    // Match the engine's stdout contract: one {ok:false,error} JSON line + exit 1.
    process.stdout.write(
      JSON.stringify({ ok: false, error: 'no agent: pass --agent <id> or set SELF_EDIT_AGENT' }) + '\n',
    );
    process.exit(1);
  }
  // runForAgent resolves the cfg via getAgent()→selfEditConfigForAgent(), emits a clean
  // {ok:false,error}+exit1 for an unknown/unwired agent, and otherwise runs runCli() which
  // preserves the snapshot/verify/revert/log/changelog dispatch + exit codes (fail→1,
  // verify-not-ok→2, success→0).
  runForAgent(agent, rest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
