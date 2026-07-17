import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLedger, addToLedger } from './ledger.mjs';

function tmpLedger(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'sent-suggestions.json');
  writeFileSync(file, JSON.stringify(initial ?? { sent: [] }));
  return file;
}

test('checkLedger flags company/role already sent (by jobId)', () => {
  const file = tmpLedger({ sent: [] });
  addToLedger(file, [{ company: 'Acme', role: 'SDET' }]);
  const res = checkLedger(file, [{ company: 'Acme', role: 'SDET' }, { company: 'Acme', role: 'PM' }]);
  assert.equal(res.already.length, 1);
  assert.equal(res.fresh.length, 1);
  assert.equal(res.fresh[0].role, 'PM');
});

test('addToLedger appends new and de-dupes by id', () => {
  const file = tmpLedger({ sent: [{ id: 'aaa', company: 'A' }] });
  const n = addToLedger(file, [
    { id: 'aaa', company: 'A' }, // dup → ignored
    { id: 'bbb', company: 'B', url: 'u', title: 't', date: '2026-05-30' },
  ]);
  assert.equal(n, 2); // total in ledger
  const led = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(led.sent.map((x) => x.id), ['aaa', 'bbb']);
});

test('checkLedger: id present in ledger → already; absent → fresh', () => {
  const file = tmpLedger({ sent: [] });
  addToLedger(file, [{ id: 'zzz' }]);
  const res = checkLedger(file, [{ id: 'zzz' }, { id: 'yyy' }]);
  assert.deepEqual(res.already.map((x) => x.id), ['zzz']);
  assert.deepEqual(res.fresh.map((x) => x.id), ['yyy']);
});

test('checkLedger on a non-existent ledger file → everything fresh', () => {
  const res = checkLedger('/tmp/does-not-exist-ledger-xyz.json', [{ id: 'q' }]);
  assert.deepEqual(res.already, []);
  assert.equal(res.fresh.length, 1);
});

test('addToLedger upserts existing id: refreshes date, preserves first_date', () => {
  const file = tmpLedger(); // follow the file's existing tmp-file helper pattern
  addToLedger(file, [{ company: 'Wix', role: 'QA Automation Engineer', url: 'u1', title: 'QA Automation Engineer', date: '2026-06-01' }]);
  addToLedger(file, [{ company: 'Wix', role: 'QA Automation Engineer', url: 'u2', title: 'QA Automation Engineer', date: '2026-07-15' }]);
  const led = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(led.sent.length, 1);
  assert.equal(led.sent[0].date, '2026-07-15');
  assert.equal(led.sent[0].first_date, '2026-06-01');
  assert.equal(led.sent[0].url, 'u2');
});
