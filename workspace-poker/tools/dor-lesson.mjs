#!/usr/bin/env node
// dor-lesson.mjs — DYNAMIC, infinite, non-repeating daily-lesson driver for Dor.
//
// ARCHITECTURE (same as dor-teder.mjs / zorro morning-kick — the shared "dynamic cron" pattern):
// this tool OWNS the progression state, so the cron agent never has to compose+log in one turn
// (that's what made announce ship a status line — docs/RUNBOOK.md §199–206). It walks an ordered
// syllabus, counts the lesson number UP forever, and guarantees NO repeats by tracking every topic
// already taught and handing the agent a "do NOT repeat" list. The agent only WRITES the lesson;
// the cron message carries the shared announce-contract.
//
// Usage:
//   node tools/dor-lesson.mjs next     # advance state, print lesson# + topic + don't-repeat list
//   node tools/dor-lesson.mjs peek     # same, WITHOUT advancing
//   node tools/dor-lesson.mjs status   # JSON: count, next topic, syllabus size
//
// Env: POKER_DATA_DIR overrides the data dir for smoke tests.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nextLesson, addTopic } from './lib/dor-lesson-dyn.mjs';
import { loadDorTag } from './lib/dor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WS = dirname(here);
const DATA_DIR = process.env.POKER_DATA_DIR || join(WS, 'data');
const SYLLABUS = join(DATA_DIR, 'dor-syllabus.json');
const STATE = join(DATA_DIR, 'dor-lesson-state.json');

const TAG = loadDorTag();

function loadSyllabus() {
  const doc = JSON.parse(readFileSync(SYLLABUS, 'utf8'));
  const topics = doc.topics || [];
  if (!topics.length) { console.error(`[dor-lesson] FATAL: empty syllabus ${SYLLABUS}`); process.exit(2); }
  return topics;
}
function loadState() {
  if (!existsSync(STATE)) return { count: 0, syllabus_index: 0, covered: [], last_topic: null };
  try { return JSON.parse(readFileSync(STATE, 'utf8')); }
  catch { return { count: 0, syllabus_index: 0, covered: [], last_topic: null }; }
}

function argVal(name) { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : undefined; }

const cmd = process.argv[2] || 'next';
const syllabus = loadSyllabus();
const state = loadState();

// --- topic management (so דאוס can grow the syllabus on request, safely) ---
if (cmd === 'add-topic') {
  const t = { key: argVal('--key'), title: argVal('--title'), brief: argVal('--brief') };
  let updated;
  try { updated = addTopic(syllabus, t); }
  catch (e) { console.error(`[dor-lesson] add-topic failed: ${e.message}`); process.exit(2); }
  const doc = JSON.parse(readFileSync(SYLLABUS, 'utf8'));
  doc.topics = updated;
  writeFileSync(SYLLABUS, JSON.stringify(doc, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, added: t.key, total_topics: updated.length }, null, 2));
  process.exit(0);
}
if (cmd === 'list-topics') {
  const coveredSet = new Set((state.covered || []));
  console.log(JSON.stringify({
    total: syllabus.length,
    topics: syllabus.map((t) => ({ key: t.key, title: t.title, taught: coveredSet.has(t.title) })),
  }, null, 2));
  process.exit(0);
}

const { lessonNumber, topic, advanced, covered, nextState } = nextLesson(syllabus, state);

if (cmd === 'status') {
  console.log(JSON.stringify({
    next_lesson_number: lessonNumber, next_topic: topic.title, advanced,
    syllabus_total: syllabus.length, syllabus_index: state.syllabus_index || 0,
    taught_so_far: covered.length, last_topic: state.last_topic || null,
  }, null, 2));
  process.exit(0);
}

// stdout = an INSTRUCTION BLOCK the agent reads to WRITE the lesson (NOT echoed verbatim).
const block =
`שיעור #${lessonNumber} — נושא להיום: ${topic.title}
מה ללמד: ${topic.brief}

הנחיות כתיבה:
- עברית, אמוג'ים, פתח בשורה "📚 שיעור #${lessonNumber} ☕️".
- לַמֵּד את הנושא לעומק עם דוגמה קונקרטית אחת + טעות נפוצה אחת של מתחילים. רלוונטי לשחקן מתחיל במשחק ביתי.
- אם הנושא הוא ידיים — תן לכל יד: אקוויטי מול יד אקראית, מאיזו פוזיציה לפתוח, ואיך הפוזיציה משנה את המשחק אחרי הפלופ.
- סיים בתיוג ${TAG}.
- אל תחזור על נושאים/ידיים שכבר נלמדו: ${covered.join(', ') || '(אין עדיין)'}`;

process.stdout.write(block + '\n');

if (cmd === 'next') {
  writeFileSync(STATE, JSON.stringify({ ...state, ...nextState }, null, 2) + '\n');
}
process.exit(0);
