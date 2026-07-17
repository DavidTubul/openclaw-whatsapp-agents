#!/usr/bin/env node
// dor-quiz.mjs — DYNAMIC evening quiz that tests THAT MORNING's dynamic lesson.
//
// Reads the last lesson topic from data/dor-lesson-state.json (written by dor-lesson.mjs) and
// hands the agent an instruction to write a 4-option quiz about it — WITHOUT revealing the answer.
// Read-only on state (the lesson tool owns progression). The cron message carries the shared
// announce-contract; the agent only WRITES the quiz.
//
// Usage: node tools/dor-quiz.mjs [print]
// Env:   POKER_DATA_DIR overrides the data dir for smoke tests.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDorTag } from './lib/dor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WS = dirname(here);
const DATA_DIR = process.env.POKER_DATA_DIR || join(WS, 'data');
const STATE = join(DATA_DIR, 'dor-lesson-state.json');

const TAG = loadDorTag();

let topic = null;
if (existsSync(STATE)) {
  try { topic = JSON.parse(readFileSync(STATE, 'utf8')).last_topic || null; } catch { /* ignore */ }
}

const subject = topic
  ? `נושא שיעור הבוקר היה: "${topic}". בנה חידון שבודק את ההבנה של הנושא הזה.`
  : 'בחר מושג בסיסי אחד מהשיעורים האחרונים ובנה חידון שבודק אותו.';

process.stdout.write(
`כתוב חידון ערב קצר. ${subject}

הנחיות:
- פתח בשורה "🎯 חידון ערב".
- שאלה אחת ממוקדת על מושג/החלטה מהשיעור, עם 4 אפשרויות מסומנות א/ב/ג/ד.
- אל תחשוף את התשובה הנכונה ואל תרמוז עליה. סיים ב"מה התשובה? 🤔 ${TAG}".
- עברית, אמוג'ים, קצר.
`);
process.exit(0);
