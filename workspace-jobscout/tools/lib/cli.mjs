// Shared CLI helpers for the job-scout tools (search / linkedin / telegram / gmail / sheet).
// Extracted to kill the per-file copies of arg-parsing, the JSON error shape, state IO, and sleeps.
import { readFileSync, existsSync } from 'node:fs';

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

// NOTE: writeJsonAtomic moved to the shared atomic-write primitive (shared/lib/fs-atomic.mjs).
// Import it from there. CAREFUL when migrating a call site: the shared default is pretty=2, whereas
// this module's default was COMPACT — every former compact caller must pass { pretty: 0 } explicitly
// (the shared writer also appends a trailing newline; the state files are JSON.parse-consumed, so
// that is harmless).
