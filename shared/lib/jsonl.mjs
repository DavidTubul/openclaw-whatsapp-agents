// shared/lib/jsonl.mjs — JSONL ledger read/write, ONE implementation for every bot.
//
// pitzi (cases), zorro (streaks + morning-kick) each hand-rolled the same read/write pair for
// their append-per-line JSON ledgers. This is that pair, byte-for-byte compatible with the
// originals so migrated ledgers stay identical on disk.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.mjs";

/**
 * Read a JSONL file → array of parsed objects. Missing file → []. Blank lines and
 * corrupt (unparseable) lines are skipped. Matches the strictest existing behavior:
 * each line is trimmed BEFORE the blank filter, so whitespace-only lines drop out too.
 * @param {string} path
 * @returns {object[]}
 */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Rewrite a JSONL file atomically (tmp + rename, via fs-atomic). Exact format of the
 * former inline one-liners: one compact JSON object per line, joined by "\n", with a
 * SINGLE trailing newline only when there is at least one row (empty rows → empty file).
 * @param {string} path
 * @param {object[]} rows
 */
export function writeJsonl(path, rows) {
  writeFileAtomic(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}
