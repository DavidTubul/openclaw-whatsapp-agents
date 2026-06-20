import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, jobId } from './jobkey.mjs';

test('normalize strips suffix, case, emoji, punctuation', () => {
  assert.equal(normalize('SolarEdge Ltd. 🚀'), 'solaredge');
  assert.equal(normalize('JFrog בע"מ'), 'jfrog');
});

test('same company+role in different forms => same id', () => {
  const a = jobId('SolarEdge Ltd.', 'QA Automation Engineer');
  const b = jobId('solaredge', 'qa automation engineer');
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

test('different roles at same company => different ids', () => {
  const a = jobId('Acme', 'QA Automation Engineer');
  const b = jobId('Acme', 'Senior SDET');
  assert.notEqual(a, b);
});

test('missing company or role => null', () => {
  assert.equal(jobId('', 'QA'), null);
  assert.equal(jobId('Acme', '  '), null);
});
