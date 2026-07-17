// shared/lib/session-hygiene.test.mjs
//
// Ports the pure-decision tests from all three original per-bot suites
// (workspace-jobscout/poker/quitsmoke tools/session-hygiene.test.mjs) onto the unified module,
// plus tests for the new shared seams (decideRun composer, expandHome, notifyMessageFor,
// resolveAgentWiring) and an end-to-end runHygiene reset with injected side effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGroupSession, isIdle, isWithinWindow, decide, isPoisoned, isTokenOverflowed,
  hasCompactionMarker, isTranscriptPoisoned, findActiveCronKey,
  decideForce, decideProactivePoison, decideRun, performReset, pruneOldFiles,
  jerusalemParts, tsStamp, expandHome, notifyMessageFor, resolveAgentWiring, runHygiene,
} from './session-hygiene.mjs';
import { mkdtemp, writeFile as wf, readdir, mkdir, readFile, utimes } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const KEY = 'agent:main:whatsapp:group:120363000000000000@g.us';

// --- resolveGroupSession -----------------------------------------------------
test('resolveGroupSession returns sid+file when present, null otherwise', () => {
  const store = { [KEY]: { sessionId: 's1', sessionFile: '/f/s1.jsonl' }, other: {} };
  assert.deepEqual(resolveGroupSession(store, KEY), { sessionId: 's1', sessionFile: '/f/s1.jsonl' });
  assert.equal(resolveGroupSession({}, KEY), null);
  assert.equal(resolveGroupSession({ [KEY]: { sessionId: 's1' } }, KEY), null);
});

// --- isIdle ------------------------------------------------------------------
test('isIdle: true when transcript untouched longer than idleSecs', () => {
  const now = 1_000_000;
  assert.equal(isIdle(now - 200_000, now, 90), true);
  assert.equal(isIdle(now - 10_000, now, 90), false);
});

// --- isPoisoned (jobscout's richer set) --------------------------------------
test('isPoisoned: assistant-only transcript (the real failure) → true', () => {
  const lines = [
    JSON.stringify({ type: 'session' }),
    JSON.stringify({ type: 'thinking_level_change' }),
    JSON.stringify({ message: { role: 'assistant', content: 'scout report' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'reset notice' } }),
    JSON.stringify({ type: 'custom' }),
  ].join('\n');
  assert.equal(isPoisoned(lines), true);
});

test('isPoisoned: healthy transcript with a user turn → false (idle-gate respected)', () => {
  const lines = [
    JSON.stringify({ message: { role: 'assistant', content: 'hi' } }),
    JSON.stringify({ message: { role: 'user', content: 'real question' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'answer' } }),
  ].join('\n');
  assert.equal(isPoisoned(lines), false);
});

test('isPoisoned: empty / no assistant messages → false (nothing to recover)', () => {
  assert.equal(isPoisoned(''), false);
  assert.equal(isPoisoned('\n  \n'), false);
  assert.equal(isPoisoned(JSON.stringify({ type: 'session' })), false);
});

test('isPoisoned: tolerates non-JSON / blank lines, reads role|message.role|type', () => {
  const lines = [
    'not json at all',
    '',
    JSON.stringify({ role: 'assistant', content: 'x' }),
    JSON.stringify({ type: 'user' }), // user via top-level type → not poisoned
  ].join('\n');
  assert.equal(isPoisoned(lines), false);
});

test('isPoisoned: Hebrew healthy transcript (poker/zorro shape) → false', () => {
  const healthy = [
    JSON.stringify({ message: { role: 'user', content: 'דילר היי' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'שלום' } }),
  ].join('\n');
  assert.equal(isPoisoned(healthy), false);
});

// --- hasCompactionMarker (2026-07-15: the GENUINE compaction signal) ---------
test('hasCompactionMarker: role compactionSummary / isCompactSummary / compact_boundary → true', () => {
  assert.equal(hasCompactionMarker(JSON.stringify({ message: { role: 'compactionSummary', summary: 's' } })), true);
  assert.equal(hasCompactionMarker(JSON.stringify({ role: 'compactionSummary' })), true);
  assert.equal(hasCompactionMarker(JSON.stringify({ isCompactSummary: true })), true);
  assert.equal(hasCompactionMarker(JSON.stringify({ isCompactionSummary: true })), true);
  assert.equal(hasCompactionMarker(JSON.stringify({ subtype: 'compact_boundary' })), true);
});

test('hasCompactionMarker: a plain assistant-only transcript has NO marker → false', () => {
  const assistantOnly = [
    JSON.stringify({ type: 'session' }),
    JSON.stringify({ message: { role: 'assistant', content: 'cron report' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'another digest' } }),
  ].join('\n');
  assert.equal(hasCompactionMarker(assistantOnly), false);
  assert.equal(hasCompactionMarker(''), false);
  assert.equal(hasCompactionMarker('not json'), false);
});

// --- isTranscriptPoisoned (2026-07-15: assistant-only needs corroboration) ---
test('isTranscriptPoisoned: assistant-only ALONE (under size, no marker, no overflow) → HEALTHY (false)', () => {
  assert.equal(isTranscriptPoisoned({ assistantOnly: true, compactionMarker: false, sizeOverflow: false, tokenOverflow: false }), false);
});

test('isTranscriptPoisoned: assistant-only + a genuine corroborating signal → poisoned (true)', () => {
  assert.equal(isTranscriptPoisoned({ assistantOnly: true, compactionMarker: true, sizeOverflow: false, tokenOverflow: false }), true);
  assert.equal(isTranscriptPoisoned({ assistantOnly: true, compactionMarker: false, sizeOverflow: true, tokenOverflow: false }), true);
  assert.equal(isTranscriptPoisoned({ assistantOnly: true, compactionMarker: false, sizeOverflow: false, tokenOverflow: true }), true);
});

test('isTranscriptPoisoned: a corroborating signal WITHOUT assistant-only → not transcript-poison (false)', () => {
  // a healthy transcript that has a user turn is never transcript-poisoned, even if oversized
  // (size-cap resets are handled by decide(), idle-gated — not by the idle-bypassing poison path).
  assert.equal(isTranscriptPoisoned({ assistantOnly: false, compactionMarker: true, sizeOverflow: true, tokenOverflow: false }), false);
});

// --- findActiveCronKey (2026-07-15: skip store rewrites while a cron run is in-flight) --------
test('findActiveCronKey: in-flight cron entry (live lifecycleRevision, recent) → returns its key', () => {
  const now = 1_000_000_000_000;
  const store = {
    'agent:main:whatsapp:group:1@g.us': { sessionId: 's', sessionFile: '/f' },
    'agent:main:cron:abc': { lifecycleRevision: 'rev-1', updatedAt: now - 60_000 }, // 1 min old
  };
  assert.equal(findActiveCronKey(store, 'agent:main:cron:', now, 30 * 60_000), 'agent:main:cron:abc');
});

test('findActiveCronKey: FINALIZED cron entry (no lifecycleRevision) → null (never blocks)', () => {
  const now = 1_000_000_000_000;
  const store = {
    'agent:main:cron:done': { updatedAt: now, totalTokens: 5000, contextTokens: 1_048_576 }, // finished shape
  };
  assert.equal(findActiveCronKey(store, 'agent:main:cron:', now, 30 * 60_000), null);
});

test('findActiveCronKey: STALE revision (older than window, e.g. crashed run) → null (ages out)', () => {
  const now = 1_000_000_000_000;
  const store = { 'agent:main:cron:stale': { lifecycleRevision: 'rev-x', updatedAt: now - 60 * 60_000 } }; // 60 min old
  assert.equal(findActiveCronKey(store, 'agent:main:cron:', now, 30 * 60_000), null);
});

test('findActiveCronKey: scopes to THIS agent — another agent\'s cron entry is ignored', () => {
  const now = 1_000_000_000_000;
  const store = { 'agent:poker:cron:abc': { lifecycleRevision: 'rev', updatedAt: now } };
  assert.equal(findActiveCronKey(store, 'agent:main:cron:', now, 30 * 60_000), null);
});

// --- isTokenOverflowed (2026-07-01 poker/דאוס root cause: empty transcript, poisoned entry) ------
test('isTokenOverflowed: totalTokens > contextTokens → true (the דאוס incident shape)', () => {
  assert.equal(isTokenOverflowed({ totalTokens: 1_254_397, contextTokens: 1_048_576 }), true);
});

test('isTokenOverflowed: totalTokens <= contextTokens → false', () => {
  assert.equal(isTokenOverflowed({ totalTokens: 60_154, contextTokens: 1_048_576 }), false);
  assert.equal(isTokenOverflowed({ totalTokens: 1_048_576, contextTokens: 1_048_576 }), false);
});

test('isTokenOverflowed: missing/non-numeric fields → false (no false positive on a bare entry)', () => {
  assert.equal(isTokenOverflowed({}), false);
  assert.equal(isTokenOverflowed(undefined), false);
  assert.equal(isTokenOverflowed({ totalTokens: 'x', contextTokens: 1_048_576 }), false);
});

// --- decideForce -------------------------------------------------------------
test('decideForce: poisoned + BUSY (not idle) → RESET — the core fix (busy group never idles)', () => {
  const d = decideForce({ forceReset: false, forcePoisoned: true, poisoned: true, idle: false });
  assert.equal(d.reset, true);
  assert.equal(d.deferred, false);
});

test('decideForce: poisoned + idle → RESET too', () => {
  assert.equal(decideForce({ forcePoisoned: true, poisoned: true, idle: true }).reset, true);
});

test('decideForce: NOT poisoned + busy → DEFER (healthy busy chat never interrupted)', () => {
  const d = decideForce({ forceReset: false, forcePoisoned: true, poisoned: false, idle: false });
  assert.equal(d.reset, false);
  assert.equal(d.deferred, true);
});

test('decideForce: NOT poisoned + idle → reset (fallback to plain force-reset)', () => {
  assert.equal(decideForce({ forcePoisoned: true, poisoned: false, idle: true }).reset, true);
});

test('decideForce: plain --force-reset still idle-gated (busy → defer, idle → reset)', () => {
  assert.equal(decideForce({ forceReset: true, forcePoisoned: false, idle: false }).reset, false);
  assert.equal(decideForce({ forceReset: true, forcePoisoned: false, idle: true }).reset, true);
});

// --- decideProactivePoison ---------------------------------------------------
test('decideProactivePoison: assistant-only session → reset, SILENT, idle-gate bypassed (morning fix)', () => {
  const d = decideProactivePoison({ poisoned: true });
  assert.equal(d.reset, true);
  assert.equal(d.deferred, false);
  assert.equal(d.silent, true, 'must be silent — a notify would re-create an assistant-only session and re-poison');
  assert.equal(d.recordDaily, false);
});

test('decideProactivePoison: healthy session → no reset (and never announces)', () => {
  const d = decideProactivePoison({ poisoned: false });
  assert.equal(d.reset, false);
  assert.equal(d.silent, true);
});

// --- isWithinWindow (both jobscout 07:30 and poker/zorro 06:00 windows) ------
test('isWithinWindow: minute-of-day inside [start, start+span)', () => {
  assert.equal(isWithinWindow(7, 32, 7, 30, 10), true);
  assert.equal(isWithinWindow(7, 30, 7, 30, 10), true);
  assert.equal(isWithinWindow(7, 40, 7, 30, 10), false);
  assert.equal(isWithinWindow(8, 0, 7, 30, 10), false);
  // poker/zorro 06:00 window
  assert.equal(isWithinWindow(6, 2, 6, 0, 10), true);
  assert.equal(isWithinWindow(6, 0, 6, 0, 10), true);
  assert.equal(isWithinWindow(6, 10, 6, 0, 10), false);
});

// --- decide ------------------------------------------------------------------
test('decide: below thresholds → no reset', () => {
  const d = decide({ bytes: 500, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false });
  assert.deepEqual({ reset: d.reset, deferred: d.deferred, recordDaily: d.recordDaily }, { reset: false, deferred: false, recordDaily: false });
});

test('decide: size hit + idle → reset (not daily)', () => {
  const d = decide({ bytes: 2000, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(d.reset, true); assert.equal(d.recordDaily, false);
});

test('decide: size hit but busy → deferred, no reset', () => {
  const d = decide({ bytes: 2000, maxBytes: 1000, idle: false, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(d.reset, false); assert.equal(d.deferred, true);
});

test('decide: daily window + idle + not done → reset and recordDaily', () => {
  const d = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: false });
  assert.equal(d.reset, true); assert.equal(d.recordDaily, true);
});

test('decide: daily window but already done today → no reset', () => {
  const d = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: true });
  assert.equal(d.reset, false);
});

// --- decideRun (new composer; must match the original inline mode selection) -
test('decideRun: force/poison precedence matches the original inline ternary', () => {
  // force* path → decideForce
  assert.equal(decideRun({ forcePoisoned: true, poisoned: true, idle: false, bytes: 0, maxBytes: 1, inDailyWindow: false, dailyAlreadyDone: false }).reset, true);
  // not forced, poisoned → proactive silent heal
  const pp = decideRun({ forceReset: false, forcePoisoned: false, poisoned: true, idle: false, bytes: 0, maxBytes: 1e9, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(pp.reset, true); assert.equal(pp.silent, true);
  // not forced, not poisoned → plain decide (size hit)
  const sz = decideRun({ forceReset: false, forcePoisoned: false, poisoned: false, idle: true, bytes: 2000, maxBytes: 1000, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(sz.reset, true); assert.equal(sz.silent, undefined);
});

// --- time helpers ------------------------------------------------------------
test('jerusalemParts + tsStamp: stable formatting for a known UTC instant', () => {
  const d = new Date('2026-06-26T04:35:00Z'); // 07:35 Asia/Jerusalem (UTC+3 in June)
  const jp = jerusalemParts(d, 'Asia/Jerusalem');
  assert.equal(jp.date, '2026-06-26');
  assert.equal(jp.hh, 7);
  assert.equal(jp.mm, 35);
  assert.equal(tsStamp(d, 'Asia/Jerusalem'), '20260626-073500');
});

// --- expandHome --------------------------------------------------------------
test('expandHome: leading ~ → homedir; absolute/other left untouched', () => {
  assert.equal(expandHome('~/.openclaw/agents/main/sessions'), join(homedir(), '.openclaw/agents/main/sessions'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('relative'), 'relative');
});

// --- notifyMessageFor (per-bot Hebrew strings now come from the registry sessionHygiene block) ---
test('notifyMessageFor: registry notify_message wins; generic fallback when absent', () => {
  // The per-bot Hebrew strings now live in the registry (sessionHygiene.notify_message), passed in
  // here as the sessionHygiene arg — there is no more hardcoded NOTIFY_BY_AGENT map.
  assert.match(notifyMessageFor('poker', { notify_message: 'התחלתי שיחה חדשה כדי להישאר חד 🙂 כל הקופה, התוצאות והטבלה שמורים — אפשר להמשיך כרגיל.' }), /כל הקופה, התוצאות והטבלה שמורים/);
  assert.equal(notifyMessageFor('main', { notify_message: 'custom' }), 'custom');
  assert.match(notifyMessageFor('main', {}), /הכל שמור/);        // no notify_message → generic
  assert.match(notifyMessageFor('digit', {}), /הכל שמור/);       // digit/pitzi always generic
  assert.match(notifyMessageFor('unknown-bot', {}), /הכל שמור/); // generic fallback
});

// --- resolveAgentWiring ------------------------------------------------------
test('resolveAgentWiring: builds store/key/marker/notify from the REGISTRY record (config no longer read)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wire-'));
  // configPath is retained on the record for chat-log/self-edit, but resolveAgentWiring no longer
  // reads it — the hygiene knobs and groups come from the registry record itself.
  const cfgPath = join(dir, 'bot.json');
  await wf(cfgPath, JSON.stringify({ whatsapp: { group_id: '999@g.us' } })); // present but IGNORED
  const record = {
    agentId: 'poker',
    workspaceDir: dir,
    primaryGroupId: '120363000000000003@g.us',
    groupIds: ['120363000000000003@g.us'],
    keyPrefix: 'agent:poker:',
    sessionStore: '~/.openclaw/agents/poker/sessions',
    configPath: cfgPath,
    sessionHygiene: { enabled: true, max_transcript_bytes: 600000, idle_secs: 90, notify_on_reset: true,
      notify_message: 'התחלתי שיחה חדשה כדי להישאר חד 🙂 כל הקופה, התוצאות והטבלה שמורים — אפשר להמשיך כרגיל.' },
  };
  const w = await resolveAgentWiring(record, { launcher: '/x/openclaw' });
  assert.equal(w.agentId, 'poker');
  assert.equal(w.groupId, '120363000000000003@g.us'); // from the registry record (config IGNORED)
  assert.equal(w.keyPrefix, 'agent:poker:whatsapp:group:');
  assert.equal(w.storePath, join(homedir(), '.openclaw/agents/poker/sessions/sessions.json'));
  assert.equal(w.dailyMarker, join(dir, 'data', 'session-hygiene-last-daily'));
  assert.match(w.notifyMessage, /כל הקופה, התוצאות והטבלה שמורים/);
  assert.equal(w.config.max_transcript_bytes, 600000);
});

// --- performReset (ported, both branches) ------------------------------------
test('performReset: backup store, archive transcript, run cleanup — in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyg-'));
  const store = join(dir, 'sessions.json');
  const tx = join(dir, 's1.jsonl');
  await wf(store, JSON.stringify({ k: { sessionId: 's1', sessionFile: tx } }));
  await wf(tx, 'line1\nline2\n');
  const calls = [];
  const runCleanup = async () => { calls.push('cleanup'); return { code: 0 }; };
  const res = await performReset({ storePath: store, sessionFile: tx, ts: '20260530-070000', runCleanup });
  assert.equal(res.ok, true);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('sessions.json.bak-')), 'backup made');
  assert.ok(files.some((f) => f === 's1.jsonl.archived-20260530-070000'), 'transcript archived');
  assert.ok(!files.includes('s1.jsonl'), 'original transcript moved');
  assert.deepEqual(calls, ['cleanup'], 'cleanup invoked after archive');
});

test('performReset: with sessionKey, deletes the stale ENTRY (token-overflow cure)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyg-'));
  const store = join(dir, 'sessions.json');
  const tx = join(dir, 's1.jsonl');
  const key = 'agent:zorro:whatsapp:group:777@g.us';
  // entry carries a stale over-window token count — the thing archiving the transcript can't clear
  await wf(store, JSON.stringify({ [key]: { sessionId: 's1', sessionFile: tx, totalTokens: 1242215, contextTokens: 1048576 } }));
  await wf(tx, 'line1\n');
  const res = await performReset({ storePath: store, sessionFile: tx, ts: '20260629-070000', runCleanup: async () => ({ code: 0 }), sessionKey: key });
  assert.equal(res.ok, true);
  const after = JSON.parse(await readFile(store, 'utf8'));
  assert.ok(!(key in after), 'stale session entry removed → next inbound starts fresh at 0 tokens');
});

test('performReset: rewrite preserves every UNTOUCHED entry byte-exact — incl. unknown fields + key order (cron-safety 2026-07-15)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyg-'));
  const store = join(dir, 'sessions.json');
  const tx = join(dir, 's1.jsonl');
  const groupKey = 'agent:main:whatsapp:group:777@g.us';
  const cronKey = 'agent:main:cron:5d7587f3';
  // The cron entry carries fields this lib has never heard of, in a specific order + nesting. The
  // delete-and-rewrite must round-trip it identically (JSON parse→stringify keeps unknown fields
  // and insertion order) so the gateway's lifecycle claim still recognises it at finalize.
  const cronEntry = {
    lifecycleRevision: 'ddebba5c-e8b6-4cf6-a86c-9767a2363768',
    updatedAt: 1784095436199,
    systemSent: true,
    label: 'Cron: job-scout-daily',
    skillsSnapshot: { skills: [{ name: 'job-scout' }], version: 1784094792795, promptRef: { hash: 'abc', bytes: 8908 } },
    sessionId: '862cd126-adfb-40be-a4ae-d0582385b9b7',
    someFutureUnknownField: { nested: [1, 2, 3], flag: false },
  };
  await wf(store, JSON.stringify({ [groupKey]: { sessionId: 's1', sessionFile: tx }, [cronKey]: cronEntry }));
  await wf(tx, 'line1\n');
  const res = await performReset({ storePath: store, sessionFile: tx, ts: '20260715-091200', runCleanup: async () => ({ code: 0 }), sessionKey: groupKey });
  assert.equal(res.ok, true);
  const after = JSON.parse(await readFile(store, 'utf8'));
  assert.ok(!(groupKey in after), 'the targeted group entry is deleted');
  assert.deepEqual(after[cronKey], cronEntry, 'untouched cron entry is preserved (deep-equal, unknown fields carried through)');
  assert.equal(JSON.stringify(after[cronKey]), JSON.stringify(cronEntry), 'and byte-exact incl. key order');
});

test('performReset: if archive fails, abort BEFORE cleanup (no broken state)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyg-'));
  const store = join(dir, 'sessions.json');
  await wf(store, JSON.stringify({ k: {} }));
  let cleanupCalled = false;
  const runCleanup = async () => { cleanupCalled = true; return { code: 0 }; };
  const res = await performReset({ storePath: store, sessionFile: join(dir, 'missing.jsonl'), ts: 'x', runCleanup });
  assert.equal(res.ok, false);
  assert.equal(cleanupCalled, false, 'cleanup NOT called when archive fails');
});

// --- pruneOldFiles (chronological by mtime, NOT lexicographic name) ----------
test('pruneOldFiles: keeps the newest by MTIME even when the uuid-prefixed name sorts the other way', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  // Archived-transcript shape: '<uuid>.jsonl.archived-<ts>'. Deliberately make lexicographic name
  // order CONTRADICT mtime order — the newest file has the lexicographically-SMALLEST uuid prefix,
  // the oldest has the largest. A name sort would delete the newest (the forensic-loss bug); an
  // mtime sort must keep it.
  const newest = '00000000-aaaa-bbbb-cccc-000000000000.jsonl.archived-20260717-100000';
  const middle = '88888888-aaaa-bbbb-cccc-000000000000.jsonl.archived-20260717-090000';
  const oldest = 'ffffffff-aaaa-bbbb-cccc-000000000000.jsonl.archived-20260717-080000';
  for (const n of [newest, middle, oldest]) await wf(join(dir, n), 'x');
  // Set mtimes so name order (newest<middle<oldest) is the REVERSE of chronological order.
  const base = 1_784_000_000; // seconds
  await utimes(join(dir, oldest), base + 0, base + 0);
  await utimes(join(dir, middle), base + 100, base + 100);
  await utimes(join(dir, newest), base + 200, base + 200);

  await pruneOldFiles(dir, '.archived-', 1, /* contains */ true);

  const left = await readdir(dir);
  assert.deepEqual(left, [newest], 'only the newest-by-mtime archive survives (a name sort would have kept the oldest)');
});

test('pruneOldFiles: keep >= file count is a no-op; prefix filter ignores unrelated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  await wf(join(dir, 'sessions.json.bak-20260717-100000'), 'a');
  await wf(join(dir, 'sessions.json.bak-20260717-090000'), 'b');
  await wf(join(dir, 'unrelated.txt'), 'keep me');
  await pruneOldFiles(dir, 'sessions.json.bak-', 5); // keep > count → delete nothing
  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, ['sessions.json.bak-20260717-090000', 'sessions.json.bak-20260717-100000', 'unrelated.txt']);
});

// --- runHygiene end-to-end (injected side effects, real temp filesystem) -----
async function buildAgentFixture({ agentId, sessionHygiene, transcript, entryExtra }) {
  const root = await mkdtemp(join(tmpdir(), `agent-${agentId}-`));
  const ws = join(root, 'ws');
  const dataDir = join(ws, 'data');
  const storeDir = join(root, 'store');
  await mkdir(dataDir, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  const cfgPath = join(ws, 'bot.json');
  // The config file is retained (chat-log/self-edit read it) but hygiene knobs + groups now come
  // from the registry RECORD below — resolveAgentWiring no longer reads session_hygiene/whatsapp here.
  await wf(cfgPath, JSON.stringify({}));
  const storePath = join(storeDir, 'sessions.json');
  const txPath = join(storeDir, 'sess.jsonl');
  await wf(txPath, transcript);
  await wf(storePath, JSON.stringify({
    [`agent:${agentId}:whatsapp:group:777@g.us`]: { sessionId: 'sX', sessionFile: txPath, ...entryExtra },
  }));
  const record = {
    agentId,
    workspaceDir: ws,
    primaryGroupId: '777@g.us',
    groupIds: ['777@g.us'],
    keyPrefix: `agent:${agentId}:`,
    // point sessionStore at our temp store dir (no ~ so expandHome is a no-op)
    sessionStore: storeDir,
    configPath: cfgPath,
    sessionHygiene,
  };
  return { record, storePath, txPath, dataDir };
}

test('runHygiene: size-cap RESET on a healthy idle session → archives + notifies (non-silent)', async () => {
  const big = 'x'.repeat(2000);
  const transcript = [
    JSON.stringify({ message: { role: 'user', content: big } }),
    JSON.stringify({ message: { role: 'assistant', content: 'ok' } }),
  ].join('\n');
  const { record, txPath } = await buildAgentFixture({
    agentId: 'poker',
    // notify_message now lives in the registry sessionHygiene block (no more hardcoded NOTIFY_BY_AGENT).
    sessionHygiene: { enabled: true, max_transcript_bytes: 100, idle_secs: 90, notify_on_reset: true,
      notify_message: 'התחלתי שיחה חדשה כדי להישאר חד 🙂 כל הקופה, התוצאות והטבלה שמורים — אפשר להמשיך כרגיל.' },
    transcript,
  });
  const notifies = [];
  const cleanups = [];
  // session is idle: now far ahead of the file mtime
  const res = await runHygiene({
    record,
    now: new Date(Date.now() + 10 * 60 * 1000),
    log: () => {},
    runCleanup: async () => { cleanups.push(1); return { code: 0 }; },
    sendNotify: async (g, m) => { notifies.push({ g, m }); },
  });
  assert.equal(res.action, 'reset');
  assert.equal(res.decision.silent, undefined);
  assert.equal(cleanups.length, 1);
  assert.equal(notifies.length, 1, 'non-silent reset announces');
  assert.equal(notifies[0].g, '777@g.us');
  assert.match(notifies[0].m, /כל הקופה, התוצאות והטבלה שמורים/);
  const files = await readdir(join(txPath, '..'));
  assert.ok(files.some((f) => f.startsWith('sess.jsonl.archived-')), 'transcript archived');
});

test('runHygiene: proactive poison (assistant-only + corroborating compaction marker) → SILENT reset (no notify) even when busy', async () => {
  // As of 2026-07-15 assistant-only ALONE is healthy; genuine poison needs a corroborating signal.
  // Here a real compaction marker corroborates the assistant-only transcript → still a silent heal.
  const transcript = [
    JSON.stringify({ message: { role: 'assistant', content: 'cron report' } }),
    JSON.stringify({ message: { role: 'compactionSummary', summary: 'earlier turns…' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'another' } }),
  ].join('\n');
  const { record } = await buildAgentFixture({
    agentId: 'main',
    sessionHygiene: { enabled: true, max_transcript_bytes: 1000000, idle_secs: 90, notify_on_reset: true },
    transcript,
  });
  const notifies = [];
  // BUSY: now == file mtime-ish (not idle) — proactive poison must still reset, idle-gate bypassed
  const res = await runHygiene({
    record,
    now: new Date(),
    log: () => {},
    runCleanup: async () => ({ code: 0 }),
    sendNotify: async (g, m) => { notifies.push({ g, m }); },
  });
  assert.equal(res.action, 'reset');
  assert.equal(res.decision.silent, true);
  assert.equal(notifies.length, 0, 'silent reset must NOT announce (would re-poison)');
});

test('runHygiene: token-overflowed ENTRY with an EMPTY transcript → SILENT reset (דאוס 2026-07-01)', async () => {
  // Replicates the exact incident: session-init line only, no messages ever appended (every turn
  // aborted before writing), yet the entry's own totalTokens ran past its contextTokens window.
  const transcript = JSON.stringify({ type: 'session', id: 'sX' });
  const { record } = await buildAgentFixture({
    agentId: 'poker',
    sessionHygiene: { enabled: true, max_transcript_bytes: 1_000_000, idle_secs: 90, notify_on_reset: true },
    transcript,
    entryExtra: { totalTokens: 1_254_397, contextTokens: 1_048_576 },
  });
  const notifies = [];
  // BUSY (now == mtime-ish): before this fix, isPoisoned(empty transcript)=false so this would defer
  // forever in an active chat — must still reset, idle-gate bypassed, exactly like transcript-poison.
  const res = await runHygiene({
    record,
    now: new Date(),
    log: () => {},
    runCleanup: async () => ({ code: 0 }),
    sendNotify: async (g, m) => { notifies.push({ g, m }); },
  });
  assert.equal(res.action, 'reset');
  assert.equal(res.decision.silent, true);
  assert.equal(notifies.length, 0, 'silent reset must NOT announce');
});

test('runHygiene: assistant-only BUT healthy (under cap, no marker, no overflow) → NOOP (stops the 2026-07-15 reset loop)', async () => {
  // The exact misfire: since 2026.7.1, inbound non-mentions never reach the session, so Scotty's
  // quiet group holds ONLY his own cron digests = assistant-only, yet perfectly healthy. This MUST
  // NOT proactively reset (that was a 5-min reset loop). now == mtime-ish → busy, to prove it is the
  // corroboration gate (not the idle-gate) that produces the noop.
  const transcript = [
    JSON.stringify({ type: 'session' }),
    JSON.stringify({ message: { role: 'assistant', content: 'daily scout digest' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'another digest' } }),
  ].join('\n');
  const { record } = await buildAgentFixture({
    agentId: 'main',
    sessionHygiene: { enabled: true, max_transcript_bytes: 1_000_000, idle_secs: 90, notify_on_reset: true },
    transcript,
  });
  const res = await runHygiene({
    record,
    now: new Date(),
    log: () => {},
    runCleanup: async () => { throw new Error('must NOT reset a healthy assistant-only session'); },
    sendNotify: async () => { throw new Error('must NOT notify'); },
  });
  assert.equal(res.action, 'noop');
});

test('runHygiene: assistant-only + a COMPACTION MARKER → SILENT reset (genuine poison still healed)', async () => {
  const transcript = [
    JSON.stringify({ message: { role: 'assistant', content: 'cron report' } }),
    JSON.stringify({ message: { role: 'compactionSummary', summary: 'earlier turns…' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'more' } }),
  ].join('\n');
  const { record } = await buildAgentFixture({
    agentId: 'main',
    sessionHygiene: { enabled: true, max_transcript_bytes: 1_000_000, idle_secs: 90, notify_on_reset: true },
    transcript,
  });
  const notifies = [];
  const res = await runHygiene({
    record,
    now: new Date(),
    log: () => {},
    runCleanup: async () => ({ code: 0 }),
    sendNotify: async (g, m) => { notifies.push({ g, m }); },
  });
  assert.equal(res.action, 'reset');
  assert.equal(res.decision.silent, true);
  assert.equal(notifies.length, 0, 'poison heal is silent');
});

test('runHygiene: a cron run is IN-FLIGHT → DEFER the whole run, no rewrite/cleanup/notify (2026-07-15 root cause)', async () => {
  // Group session is genuinely poisoned (assistant-only + compaction marker) so WITHOUT the cron gate
  // this would silently reset (and its cleanup subprocess would prune the in-flight cron entry and
  // crash the cron finalize). The active cron entry must make hygiene defer instead.
  const transcript = [
    JSON.stringify({ message: { role: 'assistant', content: 'cron report' } }),
    JSON.stringify({ message: { role: 'compactionSummary', summary: 's' } }),
  ].join('\n');
  const { record, storePath } = await buildAgentFixture({
    agentId: 'main',
    sessionHygiene: { enabled: true, max_transcript_bytes: 1_000_000, idle_secs: 90, notify_on_reset: true },
    transcript,
  });
  // Inject an in-flight isolated-cron entry: live lifecycleRevision + a recent updatedAt.
  const now = new Date();
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  store['agent:main:cron:5d7587f3'] = { lifecycleRevision: 'ddebba5c', sessionId: '862cd126', updatedAt: now.getTime() - 60_000 };
  await wf(storePath, JSON.stringify(store));
  const res = await runHygiene({
    record,
    now,
    log: () => {},
    runCleanup: async () => { throw new Error('must NOT run cleanup while a cron run is active'); },
    sendNotify: async () => { throw new Error('must NOT notify while a cron run is active'); },
  });
  assert.equal(res.action, 'defer');
  assert.equal(res.reason, 'cron run active');
  assert.equal(res.cronKey, 'agent:main:cron:5d7587f3');
  // the store must be untouched — the in-flight cron entry survives byte-for-byte
  const after = JSON.parse(await readFile(storePath, 'utf8'));
  assert.deepEqual(after['agent:main:cron:5d7587f3'], store['agent:main:cron:5d7587f3']);
});

test('runHygiene: healthy idle below-threshold session → noop', async () => {
  const transcript = [
    JSON.stringify({ message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'yo' } }),
  ].join('\n');
  const { record } = await buildAgentFixture({
    agentId: 'zorro',
    sessionHygiene: { enabled: true, max_transcript_bytes: 1000000, idle_secs: 90, notify_on_reset: true },
    transcript,
  });
  const res = await runHygiene({
    record,
    now: new Date(Date.now() + 10 * 60 * 1000),
    log: () => {},
    runCleanup: async () => ({ code: 0 }),
    sendNotify: async () => { throw new Error('should not notify on noop'); },
  });
  assert.equal(res.action, 'noop');
});

test('runHygiene: disabled config → skips entirely', async () => {
  const { record } = await buildAgentFixture({
    agentId: 'poker',
    sessionHygiene: { enabled: false },
    transcript: 'x',
  });
  const res = await runHygiene({ record, log: () => {} });
  assert.equal(res.action, 'disabled');
});

test('runHygiene: dry-run on a size-hit idle session → does not reset', async () => {
  const transcript = 'x'.repeat(2000);
  const { record, txPath } = await buildAgentFixture({
    agentId: 'poker',
    sessionHygiene: { enabled: true, max_transcript_bytes: 100, idle_secs: 90, notify_on_reset: true },
    transcript,
  });
  const res = await runHygiene({
    record,
    now: new Date(Date.now() + 10 * 60 * 1000),
    dryRun: true,
    log: () => {},
    runCleanup: async () => { throw new Error('no cleanup in dry-run'); },
    sendNotify: async () => { throw new Error('no notify in dry-run'); },
  });
  assert.equal(res.action, 'dry-run');
  const files = await readdir(join(txPath, '..'));
  assert.ok(!files.some((f) => f.startsWith('sess.jsonl.archived-')), 'nothing archived in dry-run');
});

test('runHygiene: daily window + idle + not-done → reset, records the daily marker', async () => {
  const transcript = [
    JSON.stringify({ message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'yo' } }),
  ].join('\n');
  const { record, txPath, dataDir } = await buildAgentFixture({
    agentId: 'zorro',
    sessionHygiene: {
      enabled: true, max_transcript_bytes: 1000000, idle_secs: 90, notify_on_reset: true,
      daily_reset: { enabled: true, hour: 6, minute: 0, span_minutes: 10, tz: 'Asia/Jerusalem' },
    },
    transcript,
  });
  // Pick a fixed "now" inside the 06:00 Asia/Jerusalem window, and backdate the transcript's mtime
  // well before it so the session is unambiguously idle (deterministic, env-independent).
  const now = new Date('2026-06-26T03:05:00Z'); // 06:05 IL (UTC+3 in June)
  const old = new Date(now.getTime() - 10 * 60 * 1000);
  await utimes(txPath, old, old);
  const res = await runHygiene({
    record,
    now,
    log: () => {},
    runCleanup: async () => ({ code: 0 }),
    sendNotify: async () => {},
  });
  assert.equal(res.action, 'reset');
  assert.equal(res.decision.recordDaily, true, 'daily reset must record the marker');
  const marker = (await readFile(join(dataDir, 'session-hygiene-last-daily'), 'utf8')).trim();
  assert.equal(marker, '2026-06-26');
});

// --- multi-group agent (digit serves 2 groups) --------------------------------
test('runHygiene: multi-group agent inspects EVERY group — a poisoned 2nd group is healed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-digit-'));
  const ws = join(root, 'ws');
  const storeDir = join(root, 'store');
  await mkdir(join(ws, 'data'), { recursive: true });
  await mkdir(storeDir, { recursive: true });
  const cfgPath = join(ws, 'bot.json');
  // groups + hygiene knobs now come from the registry RECORD (below), not the config file.
  await wf(cfgPath, JSON.stringify({}));
  const tx1 = join(storeDir, 's1.jsonl');
  const tx2 = join(storeDir, 's2.jsonl');
  // group 1: healthy small conversation; group 2: token-overflowed entry (empty transcript)
  await wf(tx1, [
    JSON.stringify({ message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'hello' } }),
  ].join('\n'));
  await wf(tx2, '');
  const storePath = join(storeDir, 'sessions.json');
  await wf(storePath, JSON.stringify({
    'agent:digit:whatsapp:group:111@g.us': { sessionId: 's1', sessionFile: tx1 },
    'agent:digit:whatsapp:group:222@g.us': { sessionId: 's2', sessionFile: tx2, totalTokens: 1_250_000, contextTokens: 1_048_576 },
  }));
  const record = {
    agentId: 'digit', workspaceDir: ws, primaryGroupId: '111@g.us',
    groupIds: ['111@g.us', '222@g.us'],
    keyPrefix: 'agent:digit:', sessionStore: storeDir, configPath: cfgPath,
    sessionHygiene: { enabled: true, max_transcript_bytes: 1000000, idle_secs: 90 },
  };
  const notifies = [];
  const res = await runHygiene({
    record,
    now: new Date(Date.now() + 10 * 60 * 1000),
    log: () => {},
    runCleanup: async () => ({ code: 0 }),
    sendNotify: async (g, m) => { notifies.push(g); },
  });
  assert.equal(res.action, 'reset', 'aggregate says a reset happened');
  assert.equal(res.groups.length, 2);
  assert.equal(res.groups.find((g) => g.groupId === '111@g.us').action, 'noop', 'healthy group untouched');
  const g2 = res.groups.find((g) => g.groupId === '222@g.us');
  assert.equal(g2.action, 'reset', 'poisoned 2nd group healed');
  assert.equal(g2.decision.silent, true, 'poison heal is silent');
  assert.equal(notifies.length, 0, 'no notify for the silent heal');
  const files = await readdir(storeDir);
  assert.ok(files.some((f) => f.startsWith('s2.jsonl.archived-')), 'group-2 transcript archived');
  assert.ok(files.some((f) => f.startsWith('s1.jsonl') && !f.includes('archived')), 'group-1 transcript intact');
});
