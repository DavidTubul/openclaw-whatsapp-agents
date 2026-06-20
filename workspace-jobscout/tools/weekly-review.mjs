#!/usr/bin/env node
// Weekly self-review aggregator (owner-only).
// Reads the Job tracker Sheet and computes an OUTCOME FUNNEL so the LLM can
// learn which sources / score-bands / companies actually convert (interview+)
// vs. which only produce noise (David marks "⛔ Not Interested") — the raw
// material for the weekly lessons file + criteria-tuning proposal.
//
//   node weekly-review.mjs            -> fetch live Sheet (via sheet.mjs read), print analysis JSON
//   node weekly-review.mjs --file x   -> analyze rows from a JSON file ({rows:[...]} or [...])
//
// analyzeRows() is pure and exported for unit tests. Deterministic by design:
// no clock/network inside the analysis — the LLM does the reasoning, this just
// shapes the data.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Status (col K) → outcome class.
//  win     : advanced past application — the scout surfaced something that paid off.
//  applied : David chose to apply — relevant enough to act on.
//  rejected: applied but the company declined — still a RELEVANT surfacing (he applied).
//  noise   : David explicitly rejected the suggestion — what the scout should stop surfacing.
//  pending : surfaced, no signal yet — not yet informative.
const STATUS_CLASS = [
  { re: /offer|🎉/i, cls: 'win' },
  { re: /interview|📞/i, cls: 'win' },
  { re: /applied|✅/i, cls: 'applied' },
  { re: /rejected|❌/i, cls: 'rejected' },
  { re: /not.?interested|⛔/i, cls: 'noise' },
  { re: /pending|⏳/i, cls: 'pending' },
];

export function classifyStatus(status) {
  const s = String(status ?? '');
  for (const { re, cls } of STATUS_CLASS) if (re.test(s)) return cls;
  return 'pending';
}

// A combined source string like "linkedin + telegram:IL_QA_Job" credits BOTH
// "linkedin" and "telegram" — split on +/, , drop the ":channel" suffix.
export function splitSources(source) {
  return String(source ?? '')
    .split(/[+,]/)
    .map((s) => s.trim().split(':')[0].trim().toLowerCase())
    .filter(Boolean);
}

export function scoreBucket(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 90) return '90+';
  if (n >= 80) return '80-89';
  if (n >= 70) return '70-79';
  return '<70';
}

const EMPTY = () => ({ total: 0, win: 0, applied: 0, rejected: 0, noise: 0, pending: 0 });

// engagement = David acted on it (applied / advanced / even applied-then-rejected).
// noise_rate = fraction he explicitly rejected as a suggestion.
function withRates(b) {
  const engaged = b.win + b.applied + b.rejected;
  return {
    ...b,
    engaged,
    engagement_rate: b.total ? Math.round((engaged / b.total) * 100) : 0,
    noise_rate: b.total ? Math.round((b.noise / b.total) * 100) : 0,
  };
}

function bump(map, key, cls) {
  if (!map[key]) map[key] = EMPTY();
  map[key].total++;
  map[key][cls]++;
}

function finalize(map) {
  return Object.fromEntries(
    Object.entries(map)
      .map(([k, b]) => [k, withRates(b)])
      .sort((a, b) => b[1].total - a[1].total),
  );
}

// Pure analysis: rows -> structured outcome report. No I/O, no clock.
export function analyzeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const overall = EMPTY();
  const bySource = {};
  const byLevel = {};
  const byScore = {};
  const wins = [];
  const noise = [];
  const applied = [];

  for (const r of list) {
    const cls = classifyStatus(r.status);
    overall.total++;
    overall[cls]++;

    for (const src of splitSources(r.source)) bump(bySource, src, cls);
    bump(byLevel, String(r.level || 'unknown').toLowerCase(), cls);
    bump(byScore, scoreBucket(r.score), cls);

    const brief = {
      title: r.title,
      company: r.company,
      source: r.source,
      score: r.score,
      level: r.level,
    };
    if (cls === 'win') wins.push({ ...brief, status: r.status, reason: r.reason });
    else if (cls === 'noise') noise.push(brief);
    else if (cls === 'applied') applied.push(brief);
  }

  return {
    total: overall.total,
    by_status: overall,
    by_source: finalize(bySource),
    by_level: finalize(byLevel),
    by_score_bucket: finalize(byScore),
    wins, // interview/offer — what worked (amplify these patterns)
    applied, // David applied — relevant surfacing
    noise, // David rejected the suggestion — stop surfacing these patterns
  };
}

function fetchRows() {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = execFileSync('node', [join(here, 'sheet.mjs'), 'read'], {
    encoding: 'utf8',
    timeout: 45000,
  });
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`sheet read failed: ${parsed.error || 'unknown'}`);
  return parsed.rows || [];
}

function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  let rows;
  try {
    if (fileIdx !== -1) {
      const raw = JSON.parse(readFileSync(args[fileIdx + 1], 'utf8'));
      rows = Array.isArray(raw) ? raw : raw.rows || [];
    } else {
      rows = fetchRows();
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...analyzeRows(rows) }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
