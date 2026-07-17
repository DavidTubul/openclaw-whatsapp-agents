import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from './fs-atomic.mjs';

test('writeFileAtomic writes content, creates parents, leaves no tmp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsatomic-'));
  try {
    const p = join(dir, 'nested', 'x.txt');
    writeFileAtomic(p, 'hello');
    assert.equal(readFileSync(p, 'utf8'), 'hello');
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['x.txt']);
    writeFileAtomic(p, 'v2'); // overwrite path
    assert.equal(readFileSync(p, 'utf8'), 'v2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeJsonAtomic pretty-prints with trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsatomic-'));
  try {
    const p = join(dir, 'x.json');
    writeJsonAtomic(p, { a: 1 });
    assert.equal(readFileSync(p, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
