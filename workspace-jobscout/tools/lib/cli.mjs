// Shared CLI helpers for the job-scout tools (search / linkedin / telegram / gmail / sheet).
// Extracted to kill the per-file copies of arg-parsing, the JSON error shape, state IO, and sleeps.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// `--person <id>` (default provided). Per-person tools read this to pick whose registry entry to use.
export function personIdFromArgv(argv = process.argv, fallback = 'david') {
  const i = argv.indexOf('--person');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

// Emit the uniform `{ok:false,error}` shape to stdout and exit 1. Accepts a string or an Error.
// Writes straight to stdout (not console.log) so a tool that redirects console.log can't swallow it.
export function failJson(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(msg?.message ?? msg), ...extra }) + '\n');
  process.exit(1);
}

// Require env vars; failJson listing any that are missing. Returns the values as an object.
export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) failJson(`missing env vars: ${missing.join(', ')}`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

// Synchronous ~ms pause (blocks the thread). Used between SEQUENTIAL queries to be gentle on rate limits.
export function sleepMsSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Async ~ms pause — for retry backoff (never blocks the event loop, so parallel fetches keep running).
export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry an async fn with exponential backoff; throws the last error if every attempt fails.
export async function withRetry(fn, { tries = 3, baseMs = 500, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (attempt < tries) {
        process.stderr.write(`[retry] ${label} ${attempt}/${tries} failed: ${e?.message}; retrying\n`);
        await sleepMs(baseMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}

// Read+parse JSON; return `fallback` on a missing file or parse error (never throws).
export function readJsonSafe(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// Atomic JSON write: mkdir -p the dir, write to a pid-scoped temp file, then rename into place —
// so a crash mid-write (or a concurrent run) can never leave a half-written/truncated state file.
export function writeJsonAtomic(file, obj, { pretty = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  renameSync(tmp, file);
}
