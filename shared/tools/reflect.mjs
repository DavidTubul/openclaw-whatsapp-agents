#!/usr/bin/env node
// shared/tools/reflect.mjs — periodic "reflection" that teaches an agent its group over time.
//
// Reads the agent's recent chat-log + its current learned notes, asks the model to rewrite a concise
// per-member + group-vibe profile, and writes it to <workspaceDir>/data/memory/group-notes.md. The
// group-memory hook then injects that file into the agent's prompt at every bootstrap, so the bot
// behaves like someone who's been in the group a while. Registry-driven; run from a daily systemd
// timer (LLM-independent of the conversational session → survives crashes).
//
// SAFETY: never corrupts existing notes — on any LLM failure/empty output it leaves the file as-is
// and exits non-zero. `--dry-run` builds + prints the prompt and does NOT call the model or write.
//
// Usage:
//   node shared/tools/reflect.mjs --agent <id> [--dry-run] [--limit 120] [--model sonnet]
//   node shared/tools/reflect.mjs --all      [--dry-run] ...
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { getAgent, listAgents } from '../lib/agent-registry.mjs';
import {
  groupNotesPath, readGroupNotes, parseChatLogTail, buildReflectionPrompt,
  stripCodeFence, validateNotesOutput,
} from '../lib/group-memory.mjs';

function out(o) { console.log(JSON.stringify(o)); }

// Read the recent tail from EVERY group the agent serves (digit has 2), not just the primary one —
// a multi-group agent's memory must learn from all of its rooms. When there are several groups the
// per-group share of `limit` is split evenly and a divider entry marks the boundary.
function chatLogTail(record, limit) {
  const groups = (record.groupIds && record.groupIds.length) ? record.groupIds : [record.primaryGroupId];
  const per = Math.max(20, Math.ceil(limit / groups.length));
  const all = [];
  for (const g of groups) {
    const p = join(record.workspaceDir, 'data', 'chat-log', `${g}.jsonl`);
    if (!existsSync(p)) continue;
    let msgs;
    try { msgs = parseChatLogTail(readFileSync(p, 'utf8'), per); } catch { continue; }
    if (!msgs.length) continue;
    if (groups.length > 1) all.push({ role: 'member', name: '—', text: `--- קבוצה: ${g} ---` });
    all.push(...msgs);
  }
  return all;
}

// Resolve the Claude CLI binary. systemd user units run with a minimal PATH that does NOT include
// ~/.local/bin (where claude is installed) — a bare `claude` spawn is exactly how the nightly
// reflect timer failed silently for days (spawnSync ENOENT). Never rely on host PATH.
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

// Call the Claude CLI in headless print mode. Returns trimmed stdout, or throws.
function runClaude(prompt, model) {
  // print mode; prompt on stdin to avoid arg-length limits. setting-sources=project keeps user-scope
  // plugins/hooks out of this headless call (see project memory: user plugins leaked into bots).
  const args = ['-p', '--model', model, '--setting-sources', 'project'];
  return execFileSync(claudeBin(), args, {
    input: prompt, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function reflectOne(agentId, { dryRun, limit, model }) {
  const record = getAgent(agentId);
  if (!record) return { ok: false, agentId, error: 'unknown agent' };

  const messages = chatLogTail(record, limit);
  const existingNotes = readGroupNotes(record);
  const prompt = buildReflectionPrompt({
    persona: record.persona && record.persona.name, ownerLabel: record.owner && record.owner.label,
    existingNotes, messages,
  });

  if (dryRun) return { ok: true, agentId, dryRun: true, messages: messages.length, promptChars: prompt.length, prompt };
  if (messages.length === 0 && !existingNotes) return { ok: true, agentId, skipped: 'no chat-log and no notes yet' };

  let updated;
  try { updated = runClaude(prompt, model); }
  catch (e) { return { ok: false, agentId, error: `claude failed: ${(e && e.message) || e}`.slice(0, 300) }; }
  updated = stripCodeFence(updated);
  // Output gate (shared lib, unit-tested): rejects empty output and meta/approval replies so a bad
  // model turn can never clobber yesterday's notes.
  const gate = validateNotesOutput(updated);
  if (!gate.ok) return { ok: false, agentId, error: gate.error };

  const notesPath = groupNotesPath(record);
  mkdirSync(dirname(notesPath), { recursive: true });
  const tmp = `${notesPath}.tmp`;
  writeFileSync(tmp, updated.endsWith('\n') ? updated : updated + '\n');
  renameSync(tmp, notesPath); // atomic swap — never leaves a half-written notes file
  return { ok: true, agentId, wrote: notesPath, bytes: updated.length, fromMessages: messages.length };
}

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const opts = {
  dryRun: argv.includes('--dry-run'),
  limit: Number(flag('--limit')) || 120,
  model: flag('--model') || 'sonnet',
};

if (argv.includes('--all')) {
  const results = listAgents().map((a) => reflectOne(a.agentId, opts));
  out({ ok: results.every((r) => r.ok), results });
  process.exit(results.every((r) => r.ok) ? 0 : 1);
} else {
  const id = flag('--agent');
  if (!id) { out({ ok: false, error: 'pass --agent <id> or --all' }); process.exit(2); }
  const r = reflectOne(id, opts);
  out(r);
  process.exit(r.ok ? 0 : 1);
}
