// shared/lib/fs-atomic.mjs — atomic file writes, ONE implementation for every bot.
//
// Every ledger in this repo (poker sessions, zorro streaks, pitzi cases, jobscout dedup, the
// gateway session store) is a small JSON file that IS the source of truth. A plain writeFileSync
// can be interrupted mid-write and leave a truncated file — corrupting the only copy. The classic
// fix: write to a temp file in the same directory, then rename() over the target (atomic on POSIX).

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write `data` to `path` atomically (tmp + rename). Creates parent dirs. */
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** JSON.stringify + trailing newline, written atomically. */
export function writeJsonAtomic(path, obj, { pretty = 2 } = {}) {
  writeFileAtomic(path, JSON.stringify(obj, null, pretty) + '\n');
}
