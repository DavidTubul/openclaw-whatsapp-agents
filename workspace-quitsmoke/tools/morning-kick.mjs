#!/usr/bin/env node
// morning-kick.mjs — deterministic assembler for זורו's ☀️ "בעיטת הבוקר".
//
// Picks the next unsent content item, logs it to data/daily/sent.jsonl, and prints
// the chosen fact + the live טבלת-הצדק (leaderboard) + who's pending — all as JSON.
// The cron agent then only has to REPHRASE the fact in זורו's brutal voice and emit
// the final message. NO sending, NO bookkeeping-by-narration.
//
// This fixes the "claims sent but didn't" bug: under cron `announce` delivery the
// agent's final turn text IS the group message, so its only job is to produce that
// text. All selection/logging that the model used to (mis)narrate now lives here.
//
// Idempotent per day: a re-run on the same date returns the SAME item and does not
// append a second sent.jsonl line.
//
// Usage (from anywhere — paths are derived):
//   node tools/morning-kick.mjs            # pick + log today's item, print JSON
//   node tools/morning-kick.mjs --dry-run  # same selection, do NOT write sent.jsonl
//
// Output: { ok, date, id, fact, leaderboard:[{rank,member_name,clean_days,last_result}],
//           pending:[name], members, alreadyLogged, note }
// Env ZORRO_DATA_DIR overrides the data dir (used by tests).

import { readFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { todayInTz } from "../../shared/lib/time.mjs";
import { readJsonl } from "../../shared/lib/jsonl.mjs";
import { leaderboard, pendingMembers, addDays } from "./lib/streaks.mjs";
import { parseContent, pickNext } from "./lib/morning.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DATA_DIR = process.env.ZORRO_DATA_DIR || resolve(ROOT, "data");
const CONTENT = resolve(ROOT, "skills", "quit-coach", "content.md");
const SENT = resolve(DATA_DIR, "daily", "sent.jsonl");
const LEDGER = resolve(DATA_DIR, "streaks", "members.jsonl");

// Asia/Jerusalem, NOT UTC — the 08:00 idempotency stamp must match the group's day.
const today = () => todayInTz();
function out(o) { console.log(JSON.stringify(o)); }
function fail(error) { console.log(JSON.stringify({ ok: false, error })); process.exit(1); }

// readJsonl now imported from shared/lib/jsonl.mjs (trim→skip blank/corrupt — identical result here).

const dry = process.argv.includes("--dry-run");
const d = today();

let contentMd;
try { contentMd = readFileSync(CONTENT, "utf8"); }
catch { fail(`cannot read content.md at ${CONTENT}`); }

const items = parseContent(contentMd);
if (!items.length) fail("no content items parsed from content.md");

const sent = readJsonl(SENT);
const pick = pickNext(items, sent, d);
if (!pick) fail("could not pick a content item");

if (!pick.alreadyLogged && !dry) {
  appendFileSync(SENT, JSON.stringify({ date: d, id: pick.id }) + "\n");
}

const members = readJsonl(LEDGER);
const lb = leaderboard(members, d).map((m) => ({
  rank: m.rank,
  member_name: m.member_name,
  clean_days: m.clean_days,
  last_result: m.last_result ?? null,
}));
const pend = pendingMembers(members, addDays(d, -1)).map((m) => m.member_name);

out({
  ok: true,
  date: d,
  id: pick.id,
  fact: pick.text,
  leaderboard: lb,
  pending: pend,
  members: members.length,
  alreadyLogged: pick.alreadyLogged,
  note:
    "נסח את ה-fact מחדש בקול הברוטלי שלך, הוסף תשאול 'עמדתם אתמול? נקי/נפלתי' ושורת טבלת-צדק מה-leaderboard. " +
    "השמות בטבלה הם רק מ-leaderboard כאן — אל תמציא אף שם. הפלט הסופי שלך = ההודעה לקבוצה בלבד.",
});
