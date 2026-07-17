import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLesson, addTopic } from './dor-lesson-dyn.mjs';

const SYL = [
  { key: 'a', title: 'נושא א', brief: '...' },
  { key: 'b', title: 'נושא ב', brief: '...' },
  { key: 'c', title: 'נושא ג', brief: '...' },
];

test('counts up from the seeded count and serves the next syllabus topic', () => {
  const r = nextLesson(SYL, { count: 6, syllabus_index: 0, covered: ['AA'] });
  assert.equal(r.lessonNumber, 7);
  assert.equal(r.topic.key, 'a');
  assert.equal(r.advanced, false);
  assert.deepEqual(r.nextState, { count: 7, syllabus_index: 1, last_topic: 'נושא א', covered: ['AA', 'נושא א'] });
});

test('never repeats: each step appends the topic to covered and advances', () => {
  let s = { count: 0, syllabus_index: 0, covered: [] };
  const titles = [];
  for (let i = 0; i < 3; i++) { const r = nextLesson(SYL, s); titles.push(r.topic.title); s = r.nextState; }
  assert.deepEqual(titles, ['נושא א', 'נושא ב', 'נושא ג']);
  assert.equal(s.count, 3);
  assert.equal(s.covered.length, 3);
});

test('past the end → infinite distinct advanced scenarios, count keeps rising', () => {
  const r1 = nextLesson(SYL, { count: 20, syllabus_index: 3, covered: [] });
  assert.equal(r1.advanced, true);
  assert.equal(r1.lessonNumber, 21);
  assert.match(r1.topic.title, /מתקדם #1/);
  const r2 = nextLesson(SYL, r1.nextState);
  assert.equal(r2.advanced, true);
  assert.match(r2.topic.title, /מתקדם #2/);
  assert.notEqual(r1.topic.title, r2.topic.title); // distinct, never loops
});

test('tolerates missing/corrupt state', () => {
  const r = nextLesson(SYL, {});
  assert.equal(r.lessonNumber, 1);
  assert.equal(r.topic.key, 'a');
});

test('throws on empty syllabus', () => {
  assert.throws(() => nextLesson([], {}));
});

test('addTopic appends a valid topic', () => {
  const out = addTopic(SYL, { key: 'icm', title: 'ICM בסיסי', brief: 'משחק קצר-סטאק בטורנירים' });
  assert.equal(out.length, 4);
  assert.equal(out[3].key, 'icm');
});

test('addTopic rejects duplicates and bad input', () => {
  assert.throws(() => addTopic(SYL, { key: 'a', title: 'נושא א', brief: 'כפילות' }), /already exists/);
  assert.throws(() => addTopic(SYL, { key: 'Bad Key', title: 'x', brief: 'yyyyy' }), /bad key/);
  assert.throws(() => addTopic(SYL, { key: 'ok', title: 'x', brief: 'yyyyy' }), /title too short/);
  assert.throws(() => addTopic(SYL, { key: 'ok', title: 'כותרת', brief: 'a' }), /brief too short/);
});
