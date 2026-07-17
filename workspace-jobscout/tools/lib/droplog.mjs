// Drop-audit log for the job scout — the observability layer that makes every future
// "why didn't I see job X?" answerable. Each dropped candidate is appended as one JSON line
// to people/<id>/data/drops.jsonl: { date, source, id, url, title, company, location, reason }.
// Reasons: off-field / junior / management / internship / location / closed / manual-only (LinkedIn) and
// location (telegram). NOTE: 'unverifiable' is NOT logged — those candidates are KEPT now.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DROPLOG_MAX_LINES = 2000; // rotate threshold
export const DROPLOG_KEEP_LINES = 1000; // how many newest lines survive a rotation

// Pure: given the existing lines, cap to the newest `keep` when over `max`. Blank lines dropped.
// Kept pure so the rotation policy is unit-testable without touching the filesystem.
export function capLines(lines, max = DROPLOG_MAX_LINES, keep = DROPLOG_KEEP_LINES) {
  const arr = (lines || []).filter((l) => typeof l === 'string' && l.trim() !== '');
  return arr.length > max ? arr.slice(arr.length - keep) : arr;
}

// Normalize one drop into the canonical record shape (stable key order; title capped at 120
// chars — Telegram posts pass the whole free-text body in as `title`, so we truncate here).
export function dropRecord({ date, source, id, url, title, company, location, reason }) {
  return {
    date: date || '',
    source: source || '',
    id: id == null ? '' : String(id),
    url: url || '',
    title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    company: company || '',
    location: location || '',
    reason: reason || '',
  };
}

// Append drop records (array) to a .jsonl file, then rotate: if the file now exceeds
// DROPLOG_MAX_LINES, rewrite it keeping only the newest DROPLOG_KEEP_LINES. No-op on [].
// Never throws on a bad individual record — best-effort observability must not break a run.
export function appendDrops(file, records) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const lines = records.map((r) => JSON.stringify(dropRecord(r)));
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, lines.join('\n') + '\n');
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const capped = capLines(existing);
  if (capped.length < existing.filter((l) => l.trim() !== '').length) {
    writeFileSync(file, capped.join('\n') + '\n');
  }
  return lines.length;
}
