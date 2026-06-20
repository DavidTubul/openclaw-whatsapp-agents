#!/usr/bin/env node
// Deterministic content key for a job, so dedup is stable across sources/runs.
//   node jobkey.mjs "<company>" "<role>"  -> prints sha256(normCompany|normRole)[:12]
// Also exports normalize() and jobId() for tests and reuse.
import { createHash } from 'node:crypto';

// Lowercase, strip company suffixes, remove emojis/punctuation, collapse whitespace.
export function normalize(s) {
  if (s == null) return '';
  let t = String(s).toLowerCase();
  // Remove emojis & most symbol/pictograph ranges.
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, ' ');
  // Strip common company suffixes (word-boundary, with/without dot).
  t = t.replace(/\b(ltd|inc|llc|co|corp|gmbh)\.?\b/g, ' ');
  t = t.replace(/בע["'`]?מ/g, ' '); // Hebrew בע"מ variants
  // Remove punctuation (keep letters/digits/whitespace, incl. Hebrew).
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // Collapse whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function jobId(company, role) {
  const c = normalize(company);
  const r = normalize(role);
  if (!c || !r) return null;
  return createHash('sha256').update(`${c}|${r}`).digest('hex').slice(0, 12);
}

function main() {
  const [company, role] = process.argv.slice(2);
  const id = jobId(company, role);
  if (!id) {
    process.stderr.write('jobkey: both <company> and <role> are required and must be non-empty after normalization\n');
    process.exit(1);
  }
  process.stdout.write(id + '\n');
}

// Run main only when invoked directly (not when imported by tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
