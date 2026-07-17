#!/usr/bin/env node
// Per-person "sent jobs" ledger — dedup memory (the only memory for guests with no Sheet).
//   node ledger.mjs <person> check '[{"company":"..","role":".."}|{"id":".."}]'  -> {already:[ids], fresh:[items]}
//   node ledger.mjs <person> add   '[{"id":"..","url":"..","title":"..","company":"..","date":".."}]' -> {total}
import { fileURLToPath } from 'node:url';
import { jobId } from './jobkey.mjs';
import { resolvePerson } from './lib/people.mjs';
import { readJsonSafe } from './lib/cli.mjs';
import { writeJsonAtomic } from '../../shared/lib/fs-atomic.mjs';

function read(file) {
  const o = readJsonSafe(file, null);
  if (!o || typeof o !== 'object') return { sent: [] };
  o.sent = o.sent || [];
  return o;
}

// Resolve each item to an id: prefer explicit item.id, else jobId(company, role).
function idOf(item) {
  if (item && typeof item.id === 'string' && item.id) return item.id;
  if (item && (item.company || item.role)) return jobId(item.company, item.role);
  return null;
}

export function checkLedger(file, items) {
  const led = read(file);
  const seen = new Map(led.sent.map((x) => [x.id, x]));
  const already = [];
  const fresh = [];
  for (const it of items) {
    const id = idOf(it);
    if (id && seen.has(id)) already.push(seen.get(id));
    else fresh.push({ ...it, id: id ?? it.id ?? null });
  }
  return { already, fresh };
}

export function addToLedger(file, items) {
  const led = read(file);
  const byId = new Map(led.sent.map((x) => [x.id, x]));
  for (const it of items) {
    const id = idOf(it);
    if (!id) continue;
    const prev = byId.get(id);
    if (prev) {
      // Re-send of a repost: refresh the record (newest send date wins) but keep the
      // original date as first_date so "how long has this been circulating" stays answerable.
      if (!prev.first_date) prev.first_date = prev.date;
      if (it.date) prev.date = it.date;
      if (it.url) prev.url = it.url;
      if (it.title) prev.title = it.title;
      if (it.company) prev.company = it.company;
    } else {
      const rec = { ...it, id };
      led.sent.push(rec);
      byId.set(id, rec);
    }
  }
  // Atomic write: this file is the ONLY dedup memory for guests — a crash mid-write
  // must never truncate it (that would re-send every past job).
  writeJsonAtomic(file, led, { pretty: 0 }); // compact (jobscout ledger format)
  return led.sent.length;
}

function main() {
  const [personId, cmd, payload] = process.argv.slice(2);
  const p = resolvePerson(personId);
  if (!p) { process.stderr.write(`ledger: unknown person "${personId}"\n`); process.exit(2); }
  const file = p.paths.ledger;
  let items = [];
  try { items = payload ? JSON.parse(payload) : []; }
  catch (e) { process.stderr.write(`ledger: bad JSON payload: ${e.message}\n`); process.exit(2); }
  if (cmd === 'check') { process.stdout.write(JSON.stringify(checkLedger(file, items)) + '\n'); return; }
  if (cmd === 'add') { process.stdout.write(JSON.stringify({ total: addToLedger(file, items) }) + '\n'); return; }
  process.stderr.write('ledger: use <person> <check|add> <json>\n'); process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
