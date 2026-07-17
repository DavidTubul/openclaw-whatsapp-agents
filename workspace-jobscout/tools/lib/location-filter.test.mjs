import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationFilter, evaluateLocation } from './location-filter.mjs';

const loc = {
  allowed: { en: ['Tel Aviv', 'Herzliya'], he: ['תל אביב', 'מודיעין'] },
  blocked: { en: ['Jerusalem', 'Haifa'], he: ['ירושלים', 'חיפה'] },
  remote_handling: { patterns_remote_global: ['remote - global', 'worldwide'] },
};

test('keeps an allowed city', () => {
  const f = buildLocationFilter(loc);
  const r = evaluateLocation('QA Engineer in Tel Aviv', f);
  assert.equal(r.keep, true);
  assert.equal(r.location, 'Tel Aviv');
});

test('drops a blocked city with no allowed city', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('QA Engineer in Jerusalem', f).keep, false);
});

test('keeps blocked+allowed (allowed overrides)', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('Hybrid: Jerusalem and Tel Aviv', f).keep, true);
});

test('keeps text with no city mentioned (lenient)', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('דרוש QA Automation מנוסה', f).keep, true);
});

test('drops global-remote with no allowed city', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('Senior QA, remote - global', f).keep, false);
});

test('matches a Hebrew allowed city', () => {
  const f = buildLocationFilter(loc);
  const r = evaluateLocation('דרוש אוטומציה במודיעין', f);
  assert.equal(r.keep, true);
  assert.equal(r.location, 'מודיעין');
});

// A flat-array config (yuval's bug): the lib must treat it as an allow-list, NOT as a no-op
// that keeps every location. Before the fix loc.allowed was undefined → everything kept.
test('flat-array config keeps an allowed city', () => {
  const f = buildLocationFilter(['רחובות', 'תל אביב', 'מרכז']);
  const r = evaluateLocation('Junior PM ברחובות', f);
  assert.equal(r.keep, true);
  assert.equal(r.location, 'רחובות');
});

test('flat-array config matches a mixed-language entry', () => {
  const f = buildLocationFilter(['רחובות', 'Tel Aviv']);
  assert.equal(evaluateLocation('Product Owner in Tel Aviv', f).keep, true);
});

test('allowed/blocked given as flat arrays still block', () => {
  const f = buildLocationFilter({ allowed: ['תל אביב'], blocked: ['ירושלים'] });
  assert.equal(evaluateLocation('PM בירושלים', f).keep, false);
  assert.equal(evaluateLocation('PM בתל אביב', f).keep, true);
});
