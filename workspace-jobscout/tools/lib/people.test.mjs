import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePerson, listEnabled, personByE164 } from './people.mjs';

const REG = {
  shared: { whatsapp_group_id: 'G@g.us', default_person: 'david' },
  people: [
    { id: 'david', name: 'David', role: 'owner', enabled: true, match_e164: [],
      capabilities: { sheet: true, gmail: true, telegram: true } },
    { id: 'yossi', name: 'אורח', role: 'guest', enabled: true, match_e164: ['972500000000'],
      capabilities: { sheet: false, gmail: false, telegram: false } },
    { id: 'old', name: 'Old', role: 'guest', enabled: false, match_e164: ['972500000099'],
      capabilities: { sheet: false, gmail: false, telegram: false } },
  ],
};

test('resolvePerson returns person with convention paths', () => {
  const p = resolvePerson('yossi', REG);
  assert.equal(p.id, 'yossi');
  assert.ok(p.paths.sources.endsWith('/people/yossi/sources.json'));
  assert.ok(p.paths.cvSummary.endsWith('/people/yossi/profile/cv-summary.json'));
  assert.ok(p.paths.ledger.endsWith('/people/yossi/data/sent-suggestions.json'));
});

test('resolvePerson unknown id → null', () => {
  assert.equal(resolvePerson('nope', REG), null);
});

test('listEnabled excludes disabled people', () => {
  const ids = listEnabled(REG).map((p) => p.id);
  assert.deepEqual(ids, ['david', 'yossi']);
});

test('personByE164 fromMe → owner', () => {
  const p = personByE164('whatever', { fromMe: true }, REG);
  assert.equal(p.id, 'david');
});

test('personByE164 known guest matches digits-only (with +, dashes)', () => {
  const p = personByE164('+972-50-000-0000', { fromMe: false }, REG);
  assert.equal(p.id, 'yossi');
});

test('personByE164 unknown sender → null', () => {
  assert.equal(personByE164('972999999999', { fromMe: false }, REG), null);
});

test('personByE164 disabled guest does not match', () => {
  assert.equal(personByE164('972500000099', { fromMe: false }, REG), null);
});
