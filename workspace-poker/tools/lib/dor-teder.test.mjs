import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMember, rosterNotesFor } from './dor-teder.mjs';

const M = [
  { name: 'שחקן א', e164: '+972500000001' },
  { name: 'שחקן ב', e164: '+972500000002' },
  { name: 'שחקן ג', e164: '+972500000003' },
];

test('rotates members in order and wraps', () => {
  let s = {};
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const r = pickMember(M, s);
    seen.push(r.member.name);
    s = r.nextState;
  }
  assert.deepEqual(seen, ['שחקן א', 'שחקן ב', 'שחקן ג', 'שחקן א']);
});

test('tolerates corrupt index', () => {
  assert.equal(pickMember(M, { next_index: 99 }).member.name, 'שחקן א');
  assert.equal(pickMember(M, { next_index: -1 }).member.name, 'שחקן ג');
});

test('throws on empty roster', () => {
  assert.throws(() => pickMember([], {}));
});

test('rosterNotesFor matches by name', () => {
  const roster = '| שחקן ב | +972500000002 | כינוי: המלך |\n| שחקן ג | +972500000003 | שחקן קבוע |';
  assert.ok(rosterNotesFor(roster, M[1]).includes('המלך'));
});

test('rosterNotesFor matches by phone even if name differs', () => {
  const roster = '| כינוי אחר | 972500000002 | כינוי: המלך |';
  assert.ok(rosterNotesFor(roster, M[1]).includes('המלך'));
});

test('rosterNotesFor returns empty when no match', () => {
  assert.equal(rosterNotesFor('nothing here', M[0]), '');
});
