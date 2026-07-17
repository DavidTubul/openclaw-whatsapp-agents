#!/usr/bin/env node
// Link-quality gate CLI for the job scout (pure logic in lib/verify-links.mjs).
//
// Usage:
//   node verify-links.mjs check [--file <path>] [--person <id>]
//     Reads a JSON array of candidates {id?,url,title?,company?} from stdin (or --file),
//     prints {ok,results:[{id,url,verdict,reason,final_url}],drop:[ids],keep:[ids]}.
//     --person <id>: also append the DROPPED items to people/<id>/data/drops.jsonl
//                    (source:"verify-links", reason = verdict + reason).
//
//   node verify-links.mjs maintenance [--dry-run]
//     Reads David's Sheet, checks every ⏳ Pending row's url, and for rows whose verdict is
//     dead/not-a-url/junk appends a Hebrew note to col M (notes only — never status/url).
//     --dry-run: print what it WOULD mark, write nothing.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { personIdFromArgv, failJson as fail } from './lib/cli.mjs';
import { resolvePerson } from './lib/people.mjs';
import { appendDrops } from './lib/droplog.mjs';
import { verifyBatch, maintenanceReason } from './lib/verify-links.mjs';
import { todayInTz, partsInTz } from '../../shared/lib/time.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLITE_MS = 150; // be gentle on the boards during a real sweep

// tz-aware (Asia/Jerusalem): a naive UTC/host date is wrong for the 00:00–03:00 Israel window.
const today = () => todayInTz();
const ddmm = () => {
  const [, m, d] = partsInTz().date.split('-'); // 'YYYY-MM-DD'
  return `${d}/${m}`;
};

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Run `node sheet.mjs <args...>` and return the parsed JSON (throws on non-ok / bad JSON).
function sheet(args) {
  const out = execFileSync('node', [join(HERE, 'sheet.mjs'), ...args], { encoding: 'utf8', timeout: 60000 });
  const parsed = JSON.parse(out);
  if (parsed.ok === false) throw new Error(`sheet ${args[0]} failed: ${parsed.error || 'unknown'}`);
  return parsed;
}

async function runCheck() {
  const args = process.argv.slice(3);
  const fileIdx = args.indexOf('--file');
  const raw = fileIdx !== -1 ? readFileSync(args[fileIdx + 1], 'utf8') : await readStdin();
  let candidates;
  try {
    const parsed = JSON.parse(raw || '[]');
    candidates = Array.isArray(parsed) ? parsed : parsed.candidates || [];
  } catch (e) { fail(`invalid JSON on stdin/--file: ${e.message}`); }

  const results = await verifyBatch(candidates, { politeMs: POLITE_MS });
  const idOf = (r) => (r.id !== '' && r.id != null ? r.id : r.url);
  const drop = results.filter((r) => r.verdict !== 'ok').map(idOf);
  const keep = results.filter((r) => r.verdict === 'ok').map(idOf);

  // --person <id>: append the dropped items to that person's drops.jsonl.
  const personIdx = process.argv.indexOf('--person');
  if (personIdx !== -1 && process.argv[personIdx + 1]) {
    const id = process.argv[personIdx + 1];
    const person = resolvePerson(id);
    if (!person) fail(`unknown person "${id}"`);
    const d = today();
    const records = results
      .map((r, i) => ({ r, c: candidates[i] || {} }))
      .filter(({ r }) => r.verdict !== 'ok')
      .map(({ r, c }) => ({
        date: d,
        source: 'verify-links',
        id: r.id,
        url: r.url,
        title: c.title || '',
        company: c.company || '',
        location: c.location || '',
        reason: `${r.verdict}: ${r.reason}`,
      }));
    try { appendDrops(person.paths.dropsLog, records); }
    catch (e) { process.stderr.write(`[verify-links] drop-log write failed: ${e.message}\n`); }
  }

  process.stdout.write(JSON.stringify({ ok: true, results, drop, keep }) + '\n');
}

async function runMaintenance() {
  const dryRun = process.argv.includes('--dry-run');
  const read = sheet(['read']);
  const rows = read.rows || [];
  const pending = rows.filter((r) => String(r.status || '').includes('⏳'));
  const cands = pending.map((r) => ({ id: r.id, url: r.url, title: r.title, company: r.company }));
  const results = await verifyBatch(cands, { politeMs: POLITE_MS });

  const stamp = ddmm();
  const marked = [];
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const row = pending[i];
    if (!['dead', 'not-a-url', 'junk'].includes(res.verdict)) continue;
    const notes = String(row.notes || '');
    if (notes.includes('🔗 הקישור')) continue; // already flagged on a previous run
    const tag = `🔗 הקישור כנראה פג — ${maintenanceReason(res.verdict)} (${stamp})`;
    const newNotes = notes ? `${notes} | ${tag}` : tag;
    const record = {
      id: row.id, company: row.company, title: row.title, url: row.url,
      verdict: res.verdict, reason: res.reason, final_url: res.final_url, notes: newNotes,
    };
    if (!dryRun) {
      try {
        const upd = sheet(['update-by-id', String(row.id), JSON.stringify({ notes: newNotes })]);
        record.updated = upd.updated ?? true;
      } catch (e) {
        record.error = e.message;
        process.stderr.write(`[verify-links] update-by-id ${row.id} failed: ${e.message}\n`);
      }
    }
    marked.push(record);
  }

  process.stdout.write(JSON.stringify({
    ok: true, dry_run: dryRun, pending: pending.length, marked_count: marked.length, marked,
  }, null, 2) + '\n');
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'check') return runCheck();
  if (cmd === 'maintenance') return runMaintenance();
  fail(`unknown command: ${cmd ?? '(none)'} — use check | maintenance`);
}

main().catch((e) => fail(e));
