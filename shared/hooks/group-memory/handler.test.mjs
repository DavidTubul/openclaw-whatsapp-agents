import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler, { injectGroupMemory } from './handler.js';
import { groupNotesPath } from '../../lib/group-memory.mjs';

function bootstrapEvent(agentId, files) {
  return { type: 'agent', action: 'bootstrap', context: { agentId, bootstrapFiles: files } };
}

// A fake registry record pointing at a TEMP workspace — tests must never touch a live bot's
// data/memory/ (a killed run would destroy real learned notes / race the reflect timer).
function tempAgent() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'gm-hook-'));
  const record = { agentId: 'zorro', workspaceDir };
  const resolveAgent = (id) => (id === 'zorro' ? record : null);
  return { record, resolveAgent, cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }) };
}

test('unregistered agent → no-op (bootstrapFiles untouched)', async () => {
  const f = { name: 'AGENTS.md', content: 'BASE' };
  await handler(bootstrapEvent('nope-not-real', [f]));
  assert.equal(f.content, 'BASE');
});

test('never throws on garbage input', async () => {
  await handler(undefined);
  await handler({});
  await handler({ context: { agentId: 'zorro', bootstrapFiles: 'not-an-array' } });
  assert.ok(true);
});

test('registered agent WITH notes → injects the learned-memory block into AGENTS.md', async () => {
  const { record, resolveAgent, cleanup } = tempAgent();
  try {
    const notesPath = groupNotesPath(record);
    mkdirSync(join(notesPath, '..'), { recursive: true });
    writeFileSync(notesPath, 'דור — אוהב הומור שחור, יום 1 נקי.');
    const f = { name: 'AGENTS.md', content: 'BASE PROMPT' };
    await injectGroupMemory(bootstrapEvent('zorro', [{ name: 'SOUL.md', content: 'x' }, f]), resolveAgent);
    assert.match(f.content, /^BASE PROMPT/);
    assert.match(f.content, /מה למדתי על הקבוצה/);
    assert.match(f.content, /דור — אוהב הומור שחור/);
  } finally {
    cleanup();
  }
});

test('registered agent with NO AGENTS.md entry → no-op (no throw)', async () => {
  const { record, resolveAgent, cleanup } = tempAgent();
  try {
    const notesPath = groupNotesPath(record);
    mkdirSync(join(notesPath, '..'), { recursive: true });
    writeFileSync(notesPath, 'something');
    const soul = { name: 'SOUL.md', content: 'x' };
    await injectGroupMemory(bootstrapEvent('zorro', [soul]), resolveAgent);
    assert.equal(soul.content, 'x');
  } finally {
    cleanup();
  }
});

test('agent with no notes file → no-op', async () => {
  const { resolveAgent, cleanup } = tempAgent();
  try {
    const f = { name: 'AGENTS.md', content: 'BASE' };
    await injectGroupMemory(bootstrapEvent('zorro', [f]), resolveAgent);
    assert.equal(f.content, 'BASE');
  } finally {
    cleanup();
  }
});
