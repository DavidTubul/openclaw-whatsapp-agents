#!/usr/bin/env node
// dor-teder.mjs — deterministic rotation for the daily "דור תרד" roast.
//
// WHY: the old teder cron told the agent to read the state file, read roster.md, write
// the roast, AND update the state JSON — all in one turn. With delivery.mode=announce the
// agent's FINAL text is posted verbatim, and that in-turn "update the state file" step
// nudged the model into a meta-preamble (e.g. "הפלט הסופי יישלח אוטומטית… ---") that then
// shipped to the group (see docs/RUNBOOK.md §199–206). This tool OWNS all state + roster
// lookup, so the cron agent's only job is to write the roast — no file ops, far less meta.
//
// Usage:
//   node tools/dor-teder.mjs next     # advance rotation, print the member + roster notes
//   node tools/dor-teder.mjs peek     # same, WITHOUT advancing
//   node tools/dor-teder.mjs status   # show rotation position
//
// Env: POKER_DATA_DIR overrides the data dir for smoke tests.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickMember, rosterNotesFor } from './lib/dor-teder.mjs';
import { todayInTz } from '../../shared/lib/time.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WS = dirname(here);
const DATA_DIR = process.env.POKER_DATA_DIR || join(WS, 'data');
const STATE = join(DATA_DIR, 'dor-teder-state.json');
const ROSTER = join(DATA_DIR, 'roster.md');

// Shared tz-aware helper (Asia/Jerusalem) — sibling poker.mjs already uses it. Behavior identical
// to the previous local Intl reimplementation, just deduplicated.
const today = () => todayInTz();

const cmd = process.argv[2] || 'next';
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const members = state.members || [];
const { member, index, nextState } = pickMember(members, state);

if (cmd === 'status') {
  console.log(JSON.stringify({
    total: members.length, current_index: index, current: member.name,
    last_sent: state.last_sent || null,
  }, null, 2));
  process.exit(0);
}

const rosterText = existsSync(ROSTER) ? readFileSync(ROSTER, 'utf8') : '';
const notes = rosterNotesFor(rosterText, member) || '(אין הערות ברוסטר — רק שם וטלפון)';

// stdout = a compact context block for the roast-writing agent. NOT a message to the group.
process.stdout.write(
  `שחקן להיום: ${member.name}\n` +
  `תיוג: @${(member.e164 || '').replace(/^\+/, '')}\n` +
  `הערות מהרוסטר:\n${notes}\n`
);

if (cmd === 'next') {
  // advance rotation + stamp date — deterministic, agent never touches the state file.
  writeFileSync(STATE, JSON.stringify({
    ...state, ...nextState, last_sent: today(),
  }, null, 2) + '\n');
}
process.exit(0);
