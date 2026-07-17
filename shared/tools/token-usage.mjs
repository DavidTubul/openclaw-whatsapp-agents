#!/usr/bin/env node
// token-usage.mjs — cross-agent token-usage monitor for the OpenClaw agents.
//
// Reads the Claude Code session transcripts under ~/.claude/projects/<project>/*.jsonl
// (each `claude -p` session — daily cron scout, Q&A turns, dev sessions — writes one
// assistant line per turn carrying message.usage), sums tokens, and prints a breakdown.
//
// Billing note: David runs on a Claude Max-5x subscription via OAuth — tokens are NOT
// billed per-token, they count toward the rolling 5-hour rate-limit window. So this is a
// "how heavy is each agent / am I close to limits" view, not a dollar bill.
//
// Usage:
//   node tools/token-usage.mjs                 # all-time, grouped by agent
//   node tools/token-usage.mjs --days 7        # last 7 days only
//   node tools/token-usage.mjs --since 2026-06-01
//   node tools/token-usage.mjs --by day        # group by calendar day (Asia/Jerusalem)
//   node tools/token-usage.mjs --by agent-day  # agent × day matrix
//   node tools/token-usage.mjs --by model      # group by model
//   node tools/token-usage.mjs --json          # machine-readable output
//
// Dedup: assistant lines are deduped by message.id, because resumed/continued sessions
// copy prior turns into new transcript files — counting files naively double-counts.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { todayInTz } from '../lib/time.mjs';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TZ = 'Asia/Jerusalem';

// Claude Code encodes a project dir as its absolute path with every '/' turned into '-'.
// Derive that prefix from the current home dir so this isn't pinned to one machine/user.
const PREFIX = os.homedir().replace(/\//g, '-'); // e.g. '/home/alice' -> '-home-alice'

// Friendly names for the known agent workspaces. Anything else falls back to the
// trailing path segment of the project dir.
// Agent display names derived from the registry (persona + workspace dir) — the old hardcoded
// map here duplicated what shared/registry.json already knows and drifted on every rename.
const AGENT_NAMES = {
  [`${PREFIX}-open-claw`]: 'dev session (this repo)',
  [`${PREFIX}-Projects`]: 'dev session (Projects)',
};
try {
  const { listAgents } = await import('../lib/agent-registry.mjs');
  for (const a of listAgents()) {
    const ws = (a.workspaceDir || '').split('/').filter(Boolean).pop();
    if (ws) AGENT_NAMES[`${PREFIX}-open-claw-${ws}`] = `${a?.persona?.name || a.agentId} (${a.agentId})`;
  }
} catch { /* registry unreadable -> generic dir names below */ }

const STRIP_PREFIX = new RegExp(`^${PREFIX}-`);

function agentName(projectDir) {
  if (AGENT_NAMES[projectDir]) return AGENT_NAMES[projectDir];
  return projectDir.replace(STRIP_PREFIX, '').replace(/-/g, '/');
}

// ---- args ----
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def;
};
const asJson = args.includes('--json');
const by = opt('by', 'agent'); // agent | day | agent-day | model
const days = opt('days') ? Number(opt('days')) : null;
let sinceMs = null;
if (days) sinceMs = Date.now() - days * 86400_000;
if (opt('since')) sinceMs = new Date(opt('since')).getTime();

function dayKey(ts) {
  // Calendar day in the agents' timezone, via the shared helper (YYYY-MM-DD).
  return todayInTz(TZ, new Date(ts));
}

// ---- scan ----
const seen = new Set(); // message.id dedup
const blank = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, webSearch: 0, webFetch: 0 });
function add(acc, u) {
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheCreate += u.cache_creation_input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.turns += 1;
  acc.webSearch += u.server_tool_use?.web_search_requests || 0;
  acc.webFetch += u.server_tool_use?.web_fetch_requests || 0;
}

const groups = new Map(); // key -> acc
const total = blank();
let scannedFiles = 0;
let firstTs = Infinity, lastTs = -Infinity;

if (!fs.existsSync(PROJECTS_DIR)) {
  console.error(`No transcripts dir: ${PROJECTS_DIR}`);
  process.exit(1);
}

for (const project of fs.readdirSync(PROJECTS_DIR)) {
  const dir = path.join(PROJECTS_DIR, project);
  if (!fs.statSync(dir).isDirectory()) continue;
  const agent = agentName(project);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    scannedFiles++;
    let data;
    try { data = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line || !line.includes('"usage"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const msg = o.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
      if (msg.id) { if (seen.has(msg.id)) continue; seen.add(msg.id); }
      const ts = o.timestamp ? Date.parse(o.timestamp) : null;
      if (sinceMs && (!ts || ts < sinceMs)) continue;
      if (ts) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }

      const u = msg.usage;
      let key;
      if (by === 'agent') key = agent;
      else if (by === 'model') key = msg.model || 'unknown';
      else if (by === 'day') key = ts ? dayKey(ts) : 'no-date';
      else if (by === 'agent-day') key = `${ts ? dayKey(ts) : 'no-date'}\t${agent}`;
      else if (by === 'agent-model') key = `${agent}  ·  ${msg.model || 'unknown'}`;
      else key = agent;

      if (!groups.has(key)) groups.set(key, blank());
      add(groups.get(key), u);
      add(total, u);
    }
  }
}

// ---- output ----
const fmt = (n) => n.toLocaleString('en-US');
const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
// Billable-equivalent total = fresh input + cache writes + cache reads + output.
const billable = (a) => a.input + a.cacheCreate + a.cacheRead + a.output;

if (asJson) {
  const out = { scope: { by, sinceMs, days }, range: { from: firstTs === Infinity ? null : new Date(firstTs).toISOString(), to: lastTs === -Infinity ? null : new Date(lastTs).toISOString() }, total, groups: {} };
  for (const [key, a] of groups) out.groups[key] = { ...a, totalTokens: billable(a) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const range = firstTs === Infinity ? 'no data' : `${new Date(firstTs).toLocaleDateString('en-CA', { timeZone: TZ })} → ${new Date(lastTs).toLocaleDateString('en-CA', { timeZone: TZ })}`;
console.log(`\n📊 Token usage — grouped by ${by}`);
console.log(`   range: ${range}${days ? ` (last ${days}d)` : sinceMs ? ` (since ${new Date(sinceMs).toLocaleDateString('en-CA', { timeZone: TZ })})` : ''}  ·  ${scannedFiles} transcript files  ·  ${total.turns} turns\n`);

const sorted = [...groups.entries()].sort((a, b) => billable(b[1]) - billable(a[1]));

if (by === 'agent-day') {
  // print grouped under day
  const rows = sorted.map(([key, a]) => { const [day, ag] = key.split('\t'); return { day, ag, a }; });
  rows.sort((x, y) => x.day < y.day ? 1 : x.day > y.day ? -1 : billable(y.a) - billable(x.a));
  let curDay = null;
  for (const r of rows) {
    if (r.day !== curDay) { console.log(`\n  ${r.day}`); curDay = r.day; }
    console.log(`    ${r.ag.padEnd(26)} ${k(billable(r.a)).padStart(8)}  (out ${k(r.a.output)}, in ${k(r.a.input)}, cache ${k(r.a.cacheRead + r.a.cacheCreate)}, ${r.a.turns} turns)`);
  }
} else {
  const w = Math.max(...sorted.map(([key]) => key.length), 12);
  console.log(`  ${'group'.padEnd(w)}  ${'total'.padStart(8)}  ${'output'.padStart(8)}  ${'input'.padStart(7)}  ${'cacheW'.padStart(7)}  ${'cacheR'.padStart(8)}  turns`);
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(7)}  ${'-'.repeat(7)}  ${'-'.repeat(8)}  -----`);
  for (const [key, a] of sorted) {
    console.log(`  ${key.padEnd(w)}  ${k(billable(a)).padStart(8)}  ${k(a.output).padStart(8)}  ${k(a.input).padStart(7)}  ${k(a.cacheCreate).padStart(7)}  ${k(a.cacheRead).padStart(8)}  ${String(a.turns).padStart(5)}`);
  }
}

console.log(`\n  ${'TOTAL'.padEnd(by === 'agent-day' ? 4 : 12)}  ${fmt(billable(total))} tokens  ·  ${fmt(total.output)} output  ·  ${fmt(total.input + total.cacheCreate + total.cacheRead)} input(+cache)  ·  ${total.turns} turns`);
if (total.webSearch || total.webFetch) console.log(`  server tools: ${total.webSearch} web_search, ${total.webFetch} web_fetch`);
console.log(`\n  ℹ️  Max-5x subscription → tokens count toward the rolling 5h rate-limit window, not a per-token bill.`);
console.log(`     "cacheR" (cache reads) is the bulk of input and is heavily discounted — the real driver is output + cacheW.\n`);
