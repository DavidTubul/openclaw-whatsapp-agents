#!/usr/bin/env node
// shared/tools/cron-feed.mjs
//
// Generic deterministic content-feed sender for any OpenClaw bot. The cron message
// (built via shared/lib/cron-contract.feedEchoMessage) runs this and echoes its stdout
// verbatim to the group. stdout is ONLY the next feed item — no LLM composes it, so no
// English/meta/"sent ✅" can leak (the bug fixed here — see docs/RUNBOOK.md §199–206).
//
// All decision logic lives in shared/lib/cron-feed.mjs; this wrapper does argv + I/O only,
// resolving the agent's workspace from the central registry (shared/lib/agent-registry.mjs).
//
// USAGE
//   node cron-feed.mjs --agent <id> --feed <name> [print|peek|status]
//     print  (default) emit next item to stdout, advance state, append to the feed log
//     peek            emit next item WITHOUT advancing
//     status          print JSON: feed size + current position (no send)
//
// FILES (resolved from the agent's dataDir = <workspaceDir>/data)
//   feeds/<name>.json         { "items": [ { "text": "<ready-to-send>", ... } ] }
//   feeds/<name>.state.json   { next_index, cycle, last_sent }   (auto-created)
//   feeds/<name>.log          delivery log (best-effort)
//
// EXIT CODES
//   0 ok | 2 usage / unknown agent / unsendable item / missing feed

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getAgent } from '../lib/agent-registry.mjs';
import { selectItem, validateText } from '../lib/cron-feed.mjs';
import { todayInTz } from '../lib/time.mjs';

const USAGE = 'usage: cron-feed.mjs --agent <id> --feed <name> [print|peek|status]';

function argVal(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function fail(msg) {
  console.error(`[cron-feed] ${msg}`);
  process.exit(2);
}

const today = (tz) => todayInTz(tz); // shared tz-correct date (one impl for all bots)

const argv = process.argv.slice(2);
const cmd = argv.find((a) => ['print', 'peek', 'status'].includes(a)) || 'print';
const agentId = argVal(argv, '--agent');
const feedName = argVal(argv, '--feed');

if (!agentId || !feedName) fail(USAGE);
if (!/^[a-zA-Z0-9_-]+$/.test(feedName)) fail(`bad feed name: ${feedName}`);

const agent = getAgent(agentId);
if (!agent) fail(`unknown agent: ${agentId}`);

const feedsDir = join(agent.dataDir, 'feeds');
const FEED = join(feedsDir, `${feedName}.json`);
const STATE = join(feedsDir, `${feedName}.state.json`);
const LOG = join(feedsDir, `${feedName}.log`);

if (!existsSync(FEED)) fail(`feed not found: ${FEED}`);

let items;
try {
  const doc = JSON.parse(readFileSync(FEED, 'utf8'));
  items = doc.items || [];
} catch (e) {
  fail(`feed unreadable: ${e.message}`);
}
if (!items.length) fail(`feed has no items: ${FEED}`);

let state = { next_index: 0, cycle: 1, last_sent: null };
if (existsSync(STATE)) {
  try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* corrupt → restart */ }
}

const { item, index, cycle, nextState } = selectItem(items, state);

if (cmd === 'status') {
  console.log(JSON.stringify({
    agent: agentId, feed: feedName, feedPath: FEED,
    total: items.length, current_index: index, cycle, last_sent: state.last_sent || null,
  }, null, 2));
  process.exit(0);
}

const bad = validateText(item.text);
if (bad) fail(`item #${index} unsendable — ${bad}`);

// stdout = the message, and ONLY the message. This is what the cron announces.
process.stdout.write(String(item.text).trim() + '\n');

if (cmd === 'print') {
  // State + log are side effects on disk only — never stdout, so they cannot
  // contaminate the announced message. Delivery already happened above.
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify({ ...nextState, last_sent: today() }, null, 2) + '\n');
  } catch (e) {
    console.error(`[cron-feed] WARN: could not persist state (${e.message}) — may repeat`);
  }
  try {
    appendFileSync(LOG, `${today()}\tidx=${index}\tcycle=${cycle}\n`);
  } catch { /* logging is best-effort */ }
}
process.exit(0);
