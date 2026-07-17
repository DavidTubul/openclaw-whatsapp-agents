import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectItem, validateText, selectRotate, selectDaily } from './cron-feed.mjs';

const F = [
  { text: 'פריט ראשון — תוכן עברי ארוך מספיק כדי לעבור ולידציה בלי שום בעיה.' },
  { text: 'פריט שני — עוד תוכן עברי תקין שנשלח כמו שהוא לקבוצה היישר מהפיד.' },
  { text: 'פריט שלישי — תוכן עברי אחרון לפני שהפיד מתגלגל חזרה להתחלה שוב.' },
];

test('starts at index 0 on empty state', () => {
  const r = selectItem(F, {});
  assert.equal(r.index, 0);
  assert.equal(r.cycle, 1);
  assert.deepEqual(r.nextState, { next_index: 1, cycle: 1 });
});

test('walks the feed in order', () => {
  let s = {};
  const seen = [];
  for (let i = 0; i < 3; i++) { const r = selectItem(F, s); seen.push(r.index); s = r.nextState; }
  assert.deepEqual(seen, [0, 1, 2]);
});

test('wraps and bumps cycle at the end', () => {
  const r = selectItem(F, { next_index: 2, cycle: 1 });
  assert.equal(r.index, 2);
  assert.deepEqual(r.nextState, { next_index: 0, cycle: 2 });
});

test('tolerates corrupt / out-of-range index', () => {
  assert.equal(selectItem(F, { next_index: 99 }).index, 0);  // 99 % 3
  assert.equal(selectItem(F, { next_index: -1 }).index, 2);  // safe negative wrap
});

test('throws on empty feed (never ship blank)', () => {
  assert.throws(() => selectItem([], {}));
});

test('validateText catches blank / non-Hebrew, passes real items', () => {
  assert.equal(validateText(F[0].text), null);
  assert.ok(validateText(''));
  assert.ok(validateText('short'));
  assert.ok(validateText('plain english feed item without any hebrew characters here'));
});

// ─── strategy: rotate (poker dor-teder pickMember) ──────────────────────────────────────────

const M = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

test('selectRotate: walks in order, wraps, cycle-free nextState (no `cycle` key)', () => {
  let s = {};
  const seen = [];
  for (let i = 0; i < 4; i++) { const r = selectRotate(M, s); seen.push(r.item.name); s = r.nextState; }
  assert.deepEqual(seen, ['a', 'b', 'c', 'a']);
  const r0 = selectRotate(M, {});
  assert.deepEqual(r0.nextState, { next_index: 1 });      // exact shape
  assert.equal('cycle' in r0.nextState, false);            // must NOT gain a cycle field
});

test('selectRotate: tolerates corrupt / negative index; throws on empty', () => {
  assert.equal(selectRotate(M, { next_index: 99 }).item.name, 'a');  // 99 % 3
  assert.equal(selectRotate(M, { next_index: -1 }).item.name, 'c');  // safe negative wrap
  assert.throws(() => selectRotate([], {}));
});

test('CONTINUITY: dor-teder-state.json (next_index=8, 9 members) picks the same member + wraps to 0', () => {
  // Fixture mirrors the SHAPE of the live workspace-poker/data/dor-teder-state.json (anonymized members).
  const state = {
    members: [
      { name: 'חבר א', e164: '+972500000001' },
      { name: 'חבר ב', e164: '+972500000002' },
      { name: 'חבר ג', e164: '+972500000003' },
      { name: 'חבר ד', e164: '+972500000004' },
      { name: 'חבר ה', e164: '+972500000005' },
      { name: 'חבר ו', e164: '+972500000006' },
      { name: 'חבר ז', e164: '+972500000007' },
      { name: 'חבר ח', e164: '+972500000008' },
      { name: 'חבר ט', e164: '+972500000009' },
    ],
    next_index: 8,
    last_sent: '2026-07-17',
  };
  const { item, index, nextState } = selectRotate(state.members, state);
  assert.equal(index, 8);
  assert.equal(item.name, 'חבר ט');   // exactly what the pre-refactor pickMember returned
  assert.deepEqual(nextState, { next_index: 0 }); // 9 members → wraps to member 0 tomorrow

  // The CLI writes {...state, ...nextState, last_sent}: assert the persisted object keeps its
  // format (members preserved, next_index advanced, NO cycle field introduced).
  const persisted = { ...state, ...nextState, last_sent: '2026-07-18' };
  assert.equal('cycle' in persisted, false);
  assert.equal(persisted.next_index, 0);
  assert.equal(persisted.members.length, 9);
  assert.deepEqual(Object.keys(persisted).sort(), ['last_sent', 'members', 'next_index']);
});

// ─── strategy: daily (zorro morning pickNext) ───────────────────────────────────────────────

const D = [{ id: 'fact-a', text: 'עובדה א' }, { id: 'fact-b', text: 'עובדה ב' }, { id: 'fact-c', text: 'עובדה ג' }];

test('selectDaily: empty sent → first item, not logged', () => {
  const p = selectDaily(D, [], '2026-06-27');
  assert.equal(p.id, 'fact-a');
  assert.equal(p.alreadyLogged, false);
});

test('selectDaily: idempotent — today already logged → same item, alreadyLogged', () => {
  const p = selectDaily(D, [{ date: '2026-06-27', id: 'fact-b' }], '2026-06-27');
  assert.equal(p.id, 'fact-b');
  assert.equal(p.text, 'עובדה ב');
  assert.equal(p.alreadyLogged, true);
});

test('selectDaily: skips sent ids; all-sent recycles least-recently-sent (list-order tie)', () => {
  assert.equal(selectDaily(D, [{ date: '2026-06-25', id: 'fact-a' }, { date: '2026-06-26', id: 'fact-b' }], '2026-06-27').id, 'fact-c');
  const recycled = selectDaily(D, [
    { date: '2026-06-20', id: 'fact-b' }, // oldest
    { date: '2026-06-24', id: 'fact-a' },
    { date: '2026-06-25', id: 'fact-c' },
  ], '2026-06-27');
  assert.equal(recycled.id, 'fact-b');
  assert.equal(recycled.alreadyLogged, false);
});

test('selectDaily: no items → null; custom idOf/textOf accessors work', () => {
  assert.equal(selectDaily([], [], '2026-06-27'), null);
  const items = [{ key: 'k1', body: 'x' }, { key: 'k2', body: 'y' }];
  const p = selectDaily(items, [{ date: '2026-06-27', id: 'k1' }], '2026-06-27', { idOf: (i) => i.key, textOf: (i) => i.body });
  assert.equal(p.id, 'k1');
  assert.equal(p.text, 'x');
  assert.equal(p.alreadyLogged, true);
});
