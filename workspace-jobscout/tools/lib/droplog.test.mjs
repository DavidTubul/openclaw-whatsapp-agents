import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capLines, dropRecord, appendDrops, DROPLOG_MAX_LINES, DROPLOG_KEEP_LINES,
} from './droplog.mjs';

test('capLines keeps everything at/under max, drops blanks', () => {
  const lines = ['a', '', 'b', '  ', 'c'];
  assert.deepEqual(capLines(lines, 10, 5), ['a', 'b', 'c']);
});

test('capLines trims to the newest `keep` when over `max`', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
  const out = capLines(lines, 10, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out, ['line8', 'line9', 'line10', 'line11']);
});

test('capLines tolerates nullish / non-string entries', () => {
  assert.deepEqual(capLines(null), []);
  assert.deepEqual(capLines([null, 42, 'x']), ['x']);
});

test('dropRecord normalizes shape, stringifies id, caps title at 120 chars', () => {
  const r = dropRecord({
    date: '2026-07-13', source: 'linkedin', id: 4434402117,
    url: 'https://x/1', title: '  Senior  QA   Engineer  ', company: 'Acme',
    location: 'Tel Aviv', reason: 'closed',
  });
  assert.equal(r.id, '4434402117');
  assert.equal(r.title, 'Senior QA Engineer'); // whitespace collapsed + trimmed
  assert.deepEqual(Object.keys(r), ['date', 'source', 'id', 'url', 'title', 'company', 'location', 'reason']);
  const long = dropRecord({ title: 'x'.repeat(200) });
  assert.equal(long.title.length, 120);
});

test('appendDrops writes one JSON line per record and returns the count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droplog-'));
  const file = join(dir, 'drops.jsonl');
  try {
    const n = appendDrops(file, [
      { date: '2026-07-13', source: 'linkedin', id: '1', reason: 'location' },
      { date: '2026-07-13', source: 'telegram:HiTech_Jobs_In_Israel', id: '2', reason: 'location' },
    ]);
    assert.equal(n, 2);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).reason, 'location');
    assert.equal(JSON.parse(lines[1]).source, 'telegram:HiTech_Jobs_In_Israel');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendDrops is a no-op on empty / non-array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droplog-'));
  const file = join(dir, 'drops.jsonl');
  try {
    assert.equal(appendDrops(file, []), 0);
    assert.equal(appendDrops(file, null), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendDrops rotates: over MAX_LINES → keeps newest KEEP_LINES', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droplog-'));
  const file = join(dir, 'drops.jsonl');
  try {
    // Seed just under the cap, then push over it in one more append.
    const seed = Array.from({ length: DROPLOG_MAX_LINES }, (_, i) => ({ id: String(i), reason: 'location' }));
    appendDrops(file, seed);
    appendDrops(file, [{ id: 'OVERFLOW', reason: 'location' }]);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, DROPLOG_KEEP_LINES);
    // the just-added overflow record must survive (it's the newest)
    assert.equal(JSON.parse(lines[lines.length - 1]).id, 'OVERFLOW');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
