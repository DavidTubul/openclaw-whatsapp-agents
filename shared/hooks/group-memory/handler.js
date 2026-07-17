// shared/hooks/group-memory/handler.js
//
// Shared bootstrap hook for ALL OpenClaw agents. At `agent:bootstrap` it folds the agent's LEARNED
// group memory (shared/lib/group-memory.mjs → <workspaceDir>/data/memory/group-notes.md) into the
// AGENTS.md system-prompt entry, so every bot wakes up already "knowing" the people, the humor and
// the dynamics it has learned — like a person who's been in the group a while, not a stranger.
//
// The notes are a FILE (not in-session state), so this knowledge survives session resets/crashes;
// tools/reflect.mjs rewrites that file periodically from the chat-log. Mirrors group-reply-policy's
// in-place mutation of event.context.bootstrapFiles (the dispatcher reads the array back).
//
// Never throws — a memory-injection failure must NOT break bootstrap. No notes → silent no-op.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getAgent } from '../../lib/agent-registry.mjs';
import { readGroupNotes, memoryInjectionBlock } from '../../lib/group-memory.mjs';

// Testing seam: `resolveAgent` is injectable so the test can point the agent record at a temp
// workspace instead of writing into a LIVE bot's data/memory/ (which raced the reflect timer and
// could destroy real learned notes if a test run was killed mid-way).
export async function injectGroupMemory(event, resolveAgent = getAgent) {
  try {
    const ctx = event?.context ?? {};
    const agent = ctx.agentId ? resolveAgent(ctx.agentId) : null;
    if (!agent) return;

    const block = memoryInjectionBlock(readGroupNotes(agent));
    if (!block) return; // no learned notes yet → inject nothing

    const files = ctx.bootstrapFiles;
    if (!Array.isArray(files)) return;
    const agentsEntry = files.find((f) => {
      const p = f && (f.path || f.name);
      return p && path.basename(String(p)) === 'AGENTS.md';
    });
    if (!agentsEntry) return;

    let base;
    if (typeof agentsEntry.content === 'string') base = agentsEntry.content;
    else if (agentsEntry.path) { try { base = readFileSync(agentsEntry.path, 'utf8'); } catch { return; } }
    else return;

    agentsEntry.content = base + '\n\n' + block;
  } catch {
    // swallow — learned-memory injection is best-effort and must never break bootstrap
  }
}

export default async function groupMemory(event) {
  return injectGroupMemory(event, getAgent);
}
