// shared/lib/session-hygiene.mjs
//
// Unified, parameterized session-hygiene logic — factored out of the three byte-identical
// per-bot copies (workspace-jobscout, workspace-poker, workspace-quitsmoke). The pure decision
// logic was IDENTICAL across all three; only the wiring constants differed (CONFIG path, session
// STORE path, KEY_PREFIX, the daily-reset window defaults, the log tag, and the per-bot Hebrew
// "started a fresh conversation" notify text).
//
// WHAT THIS KEEPS SMALL & WHY: OpenClaw's native preflight compactor is broken, so each agent's
// per-group conversational session must be kept small enough that compaction never has to run.
// This module decides — on every 5-minute timer tick — whether to RESET (archive transcript +
// prune the store entry via `openclaw sessions cleanup`; a fresh small session is auto-created on
// the next inbound; continuity survives via the chat-log hook -> RECENT_CHAT.md). Triggers:
//   • size cap          — transcript >= max_transcript_bytes
//   • idle-gated daily   — once/day inside [hour:minute, +span) in tz, only if the session is idle
//   • proactive poison   — a CORROBORATED-poison session is healed SILENTLY, idle-gate bypassed.
//                          Poison = assistant-only AND a genuine signal (compaction marker / size cap
//                          / entry token-overflow), OR token-overflow alone. Assistant-only ALONE is
//                          the norm since 2026.7.1 and is HEALTHY → noop (no reset loop). Also: the
//                          whole run is DEFERRED while an isolated cron run of the agent is in-flight.
//   • --force-reset      — manual; still idle-gated
//   • --force-reset-poisoned — watchdog recovery; bypasses idle-gate ONLY when confirmed poisoned
//
// PARAMETERIZATION: a side-effecting run is driven by an *agent record* (from
// shared/lib/agent-registry.mjs): keyPrefix, sessionStore, configPath, primaryGroupId, persona.
// Pure decision functions take plain values and are unit-tested with NO I/O. Side effects
// (archiving the transcript, `openclaw sessions cleanup`, sending the notify) sit behind thin,
// injectable functions so the pure core stays testable.
//
// BEHAVIOR PRESERVED EXACTLY per bot:
//   - jobscout (main):  STORE ~/.openclaw/agents/main/sessions/sessions.json,  keyPrefix agent:main:,
//                       daily defaults 07:30 (config supplies them), maxBytes default 1_000_000,
//                       notify "…כל המעקב והמשרות שמורים…"
//   - poker:            STORE …/agents/poker/sessions…, keyPrefix agent:poker:, daily 06:00,
//                       notify "…כל הקופה, התוצאות והטבלה שמורים…"
//   - zorro:            STORE …/agents/zorro/sessions…, keyPrefix agent:zorro:, daily 06:00,
//                       notify "…כל המעקב והרצף שלך שמורים…"
// The unified daily-window gate `(dr.enabled !== false)` is behavior-identical to jobscout's
// original ungated form: jobscout's config has no daily_reset.enabled key, so `undefined !== false`
// is true and the gate is a no-op there. poker/zorro set it true explicitly.

import { readFile, writeFile, rename, stat, readdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.mjs';
import { partsInTz } from './time.mjs';
import { launcherPath } from './paths.mjs';

// ---------------------------------------------------------------------------
// PURE decision logic (no I/O) — ported verbatim from the three identical copies.
// ---------------------------------------------------------------------------

export function resolveGroupSession(store, key) {
  const e = store?.[key];
  if (!e || !e.sessionId || !e.sessionFile) return null;
  return { sessionId: e.sessionId, sessionFile: e.sessionFile };
}

export function isIdle(mtimeMs, nowMs, idleSecs) {
  return (nowMs - mtimeMs) >= idleSecs * 1000;
}

/**
 * A "compaction-poisoned" transcript carries assistant turns (cron reports, reset notices) but
 * ZERO real user messages, so OpenClaw's preflight compactor refuses ("no real conversation
 * messages") and aborts every inbound turn. Such a session can NEVER recover on its own and
 * resetting it interrupts no live conversation — so recovery may bypass the idle-gate. We bypass
 * ONLY when this returns true. Each line is one JSON record; the role lives at `.message.role` or
 * `.role` or `.type`.
 */
export function isPoisoned(transcriptText) {
  let users = 0, assistants = 0;
  for (const line of String(transcriptText).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const role = o?.message?.role || o?.role || o?.type;
    if (role === 'user') users++;
    else if (role === 'assistant') assistants++;
  }
  return users === 0 && assistants > 0;
}

/**
 * Genuine compaction MARKER in the transcript — root-caused 2026-07-15. Since the OpenClaw 2026.7.1
 * upgrade, inbound non-mention messages never reach a group session, so assistant-only transcripts
 * became the NORM, not the exception: in a quiet group Scotty's own cron digests are the only turns
 * and the session is perfectly healthy. `isPoisoned()` (assistant-only) therefore MUST NOT stand on
 * its own as a poison signal — it needs corroboration (see isTranscriptPoisoned). A REAL preflight-
 * compaction failure leaves a `role:"compactionSummary"` record (also `isCompactSummary:true` or an
 * entry whose subtype is `compact_boundary`) in the transcript — that is the genuine marker the
 * OpenClaw compactor writes (dist run-session-state / history: `role === "compactionSummary"`).
 */
export function hasCompactionMarker(transcriptText) {
  for (const line of String(transcriptText).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const role = o.message?.role || o.role || o.type;
    if (role === 'compactionSummary' || role === 'compaction'
      || o.isCompactSummary === true || o.isCompactionSummary === true
      || o.subtype === 'compact_boundary' || o.message?.subtype === 'compact_boundary') return true;
  }
  return false;
}

/**
 * Corroborated transcript-poison decision (pure). Root-caused 2026-07-15: an assistant-only session
 * is the NORM since 2026.7.1 (inbound non-mentions no longer reach sessions), so assistant-only ALONE
 * is HEALTHY and must NOT trigger the proactive silent reset — that misfire drove a 5-minute reset
 * LOOP on Scotty's quiet group. A transcript counts as poisoned ONLY when it is assistant-only AND at
 * least one GENUINE signal corroborates it: a compaction marker in the transcript, or the transcript
 * has grown past the size cap (a big turn that will actually require compaction), or the ENTRY's own
 * token accounting has overflowed the context window (the empty-transcript / token-overflow shape).
 * Token overflow is ALSO poison on its own (handled at the caller via `poisoned = transcriptPoisoned
 * || overflowed`), so both proactive and forced recovery still bypass the idle-gate for it.
 */
export function isTranscriptPoisoned({ assistantOnly, compactionMarker, sizeOverflow, tokenOverflow }) {
  return Boolean(assistantOnly) && Boolean(compactionMarker || sizeOverflow || tokenOverflow);
}

/**
 * The OTHER poisoning shape (root-caused 2026-06-29 on זורו, recurred 2026-07-01 on poker/דאוס):
 * the session ENTRY's own totalTokens has run past its contextTokens (the 1M window) — e.g. a run
 * of repeated preflight-compaction failures each burning real tokens before aborting — so EVERY
 * inbound aborts with "Preflight compaction required but failed", yet the transcript FILE can be
 * tiny or completely empty (nothing ever got appended). `isPoisoned()` above reads only the
 * transcript and requires at least one assistant line, so it is BLIND to this shape — verified: a
 * poker session sat idle=true poisoned=false → noop for 36 straight minutes while its entry carried
 * totalTokens=1.25M > contextTokens=1.05M. Must be checked against the session-store ENTRY, not the
 * transcript file, and ORed into the same `poisoned` signal so both proactive and forced recovery
 * bypass the idle-gate for it exactly like the transcript-poison case.
 */
export function isTokenOverflowed(entry) {
  return typeof entry?.totalTokens === 'number' && typeof entry?.contextTokens === 'number'
    && entry.totalTokens > entry.contextTokens;
}

/**
 * Is an ISOLATED CRON RUN of this agent currently in-flight? Root-caused 2026-07-15. OpenClaw
 * 2026.7.1 guards each isolated cron run's `agent:<id>:cron:<uuid>` store entry with a lifecycle
 * claim (dist run-session-state-r5DnSgVq.js: at finalize it re-reads the store and throws
 * CronSessionLifecycleClaimError unless the on-disk entry's `lifecycleRevision` still matches the
 * run's). A hygiene reset MID-RUN calls `openclaw sessions cleanup --fix-missing --enforce`, which
 * PRUNES that cron entry (it has a `sessionId` but no on-disk transcript) → the finalize finds the
 * entry gone and the whole cron run fails, announcing the error into the group. So hygiene must SKIP
 * every store rewrite (both the group-key delete-rewrite AND the cleanup subprocess) while a cron run
 * is active and defer to the next tick.
 *
 * SIGNAL: an in-flight cron entry carries a live `lifecycleRevision` (+ sessionId/sessionStartedAt);
 * a FINALIZED cron entry has none (verified: the finished `551bdb61` entry on main carries only
 * token/usage fields, no lifecycleRevision). That presence is the primary "claim live" discriminator.
 * `updatedAt` is stamped at run START and NOT bumped mid-run, so it is a *staleness* guard only: a
 * crashed run could leave a stale revision, and without a window hygiene would defer forever. The
 * window must therefore exceed the longest expected cron run (job-scout runs ~12 min); default 30 min.
 * Returns the active cron key (for logging) or null.
 */
export function findActiveCronKey(store, cronKeyPrefix, nowMs, windowMs) {
  if (!store || !cronKeyPrefix) return null;
  for (const [k, e] of Object.entries(store)) {
    if (!k.startsWith(cronKeyPrefix)) continue;
    if (!e || typeof e.lifecycleRevision !== 'string' || !e.lifecycleRevision) continue;
    const updatedAt = typeof e.updatedAt === 'number' ? e.updatedAt : 0;
    if (nowMs - updatedAt <= windowMs) return k;
  }
  return null;
}

export function isWithinWindow(hh, mm, winH, winM, spanMin) {
  const cur = hh * 60 + mm, start = winH * 60 + winM;
  return cur >= start && cur < start + spanMin;
}

/**
 * Decision for the watchdog recovery modes (--force-reset / --force-reset-poisoned). Pure.
 * A confirmed-poisoned session resets EVEN WHEN NOT IDLE (a busy group never idles), while every
 * other path still respects the idle-gate.
 */
export function decideForce({ forceReset, forcePoisoned, poisoned, idle }) {
  if (forcePoisoned && poisoned) return { reset: true, deferred: false, recordDaily: false, reason: 'poisoned session — reset (idle-gate bypassed)' };
  return idle
    ? { reset: true, deferred: false, recordDaily: false, reason: forcePoisoned ? 'force-reset (not poisoned, idle)' : 'force-reset' }
    : { reset: false, deferred: true, recordDaily: false, reason: forcePoisoned ? 'not poisoned & busy — deferred' : 'force-reset requested but session busy — deferred' };
}

export function decide({ bytes, maxBytes, idle, inDailyWindow, dailyAlreadyDone }) {
  const sizeHit = bytes >= maxBytes;
  const dailyHit = inDailyWindow && !dailyAlreadyDone;
  if (!sizeHit && !dailyHit) return { reset: false, deferred: false, recordDaily: false, reason: `ok (${bytes}B)` };
  if (!idle) return { reset: false, deferred: true, recordDaily: false, reason: 'trigger met but session busy — deferred' };
  return { reset: true, deferred: false, recordDaily: dailyHit, reason: sizeHit ? `size ${bytes}>=${maxBytes}B` : 'daily window' };
}

/**
 * PROACTIVE poison self-heal. On EVERY regular hygiene run, if the live session is CORROBORATED-
 * poisoned (see isTranscriptPoisoned — assistant-only is no longer sufficient on its own since
 * 2026.7.1 made it the norm), clear it NOW — before the user ever hits the compaction error. SILENT
 * (a "started a new conversation" notify would itself create a fresh assistant-only session and
 * re-poison it). Idle-gate BYPASSED (a confirmed-poison session has no live conversation to interrupt).
 */
export function decideProactivePoison({ poisoned }) {
  return poisoned
    ? { reset: true, deferred: false, recordDaily: false, silent: true, reason: 'proactive: assistant-only session (poisoned) — clearing silently' }
    : { reset: false, deferred: false, recordDaily: false, silent: true, reason: 'not poisoned — noop' };
}

/**
 * Pure top-level decision composer (newly extracted so the mode-selection branch — previously only
 * inline in each copy's main() — is itself unit-testable). Identical logic to the original
 * inline ternary in all three copies. Returns the chosen decision object.
 */
export function decideRun({ forceReset, forcePoisoned, poisoned, idle, bytes, maxBytes, inDailyWindow, dailyAlreadyDone }) {
  if (forceReset || forcePoisoned) return decideForce({ forceReset, forcePoisoned, poisoned, idle });
  if (poisoned) return decideProactivePoison({ poisoned });
  return decide({ bytes, maxBytes, idle, inDailyWindow, dailyAlreadyDone });
}

// ---------------------------------------------------------------------------
// Time helpers (pure given now+tz) — ported verbatim.
// ---------------------------------------------------------------------------

// Now the ONE implementation lives in shared/lib/time.mjs (`partsInTz`). Re-exported here under the
// historical name so existing importers/tests (and this module's tsStamp) keep working unchanged.
export const jerusalemParts = partsInTz;

export function tsStamp(now, tz) {
  const { date, hh, mm } = jerusalemParts(now, tz);
  return `${date.replace(/-/g, '')}-${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`;
}

// ---------------------------------------------------------------------------
// Side-effecting reset (injectable cleanup) — ported verbatim.
// ---------------------------------------------------------------------------

/**
 * Atomic, restart-free reset: backup store -> archive transcript -> prune orphan via openclaw.
 * Order matters: the entry is pruned by openclaw's own command AFTER the file is archived, so the
 * missing-file-but-entry-kept state can never persist. Aborts on any error before cleanup, leaving
 * an intact (if large) session rather than a broken one.
 */
export async function performReset({ storePath, sessionFile, ts, runCleanup, sessionKey }) {
  try {
    const backup = await readFile(storePath, 'utf8');
    await writeFile(`${storePath}.bak-${ts}`, backup);
    await rename(sessionFile, `${sessionFile}.archived-${ts}`); // throws if missing -> abort, no cleanup
  } catch (e) {
    return { ok: false, stage: 'archive', error: String(e?.message || e) };
  }
  // Robust prune: delete the session ENTRY, not just its transcript. The fatal state for a
  // token-overflowed session (entry.totalTokens > entry.contextTokens → "preflight compaction
  // required") lives on the ENTRY — archiving the .jsonl does NOT clear it, and `--fix-missing`
  // races with the rapid inbound retries that recreate the file, so archive-only can leave the bot
  // PERMANENTLY stuck (verified 2026-06-29 on זורו: empty transcript, yet every turn still aborted
  // because the entry carried totalTokens=1.24M > 1.05M window). Removing the key guarantees the
  // next inbound starts a fresh 0-token session. Re-read fresh (not the backup) to shrink the
  // clobber window vs. a concurrent gateway write; best-effort — a parse error must not abort an
  // already-archived reset, cleanup still runs as the fallback.
  if (sessionKey) {
    try {
      const cur = JSON.parse(await readFile(storePath, 'utf8'));
      const bag = cur.sessions || cur;
      if (bag && Object.prototype.hasOwnProperty.call(bag, sessionKey)) {
        delete bag[sessionKey];
        // Atomic (tmp+rename): the gateway reads/writes this store concurrently — an interrupted
        // in-place write could leave IT a truncated sessions.json and kill every agent at once.
        writeFileAtomic(storePath, JSON.stringify(cur, null, 2));
      }
    } catch { /* leave the entry for cleanup --fix-missing to catch */ }
  }
  const r = await runCleanup();
  // Best-effort housekeeping: every reset leaves a store backup + an archived transcript behind;
  // with 5 bots × daily resets they accumulate forever. Keep a bounded recent window.
  await pruneOldFiles(path.dirname(storePath), `${path.basename(storePath)}.bak-`, 5);
  await pruneOldFiles(path.dirname(sessionFile), '.archived-', 10, /* contains */ true);
  return r?.code === 0 ? { ok: true } : { ok: false, stage: 'cleanup', error: `cleanup code ${r?.code}` };
}

/**
 * Delete all but the newest `keep` files in `dir` whose name starts with `prefix` (or, with
 * contains=true, contains it), keeping the `keep` most RECENT and deleting the oldest first.
 *
 * Sort key is the file's mtime (statSync), NOT the filename: a lexicographic name sort is only
 * chronological when the timestamp is the LEADING part of the name. The archived transcripts are
 * named `<session-uuid>.jsonl.archived-<ts>`, so the random uuid prefix dominates a name sort and
 * the trailing `<ts>` is ignored — a lexicographic prune could delete the NEWEST forensic archive
 * while keeping older ones. mtime is robust regardless of name shape (bak files sort the same
 * either way; archived transcripts only sort correctly by mtime).
 * Best-effort: any error leaves the extra files in place (never fails a reset over housekeeping).
 */
export async function pruneOldFiles(dir, prefix, keep, contains = false) {
  try {
    const names = (await readdir(dir))
      .filter((n) => (contains ? n.includes(prefix) : n.startsWith(prefix)));
    const stamped = [];
    for (const n of names) {
      try { const st = await stat(path.join(dir, n)); stamped.push({ n, mtimeMs: st.mtimeMs }); }
      catch { /* vanished mid-scan — skip */ }
    }
    stamped.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const { n } of stamped.slice(0, Math.max(0, stamped.length - keep))) {
      try { await unlink(path.join(dir, n)); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Wiring helpers — resolve per-agent paths/config from a registry record.
// ---------------------------------------------------------------------------

// Repo-root launcher — the ONE derivation lives in shared/lib/paths.mjs.
const DEFAULT_LAUNCHER = launcherPath;

/** Expand a leading `~` to the user's home dir (registry.sessionStore uses a literal ~). */
export function expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/'))) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Notify text for a successful (non-silent) reset. The per-bot Hebrew string now lives in the
 * registry (`sessionHygiene.notify_message` for main/poker/zorro); agents without one (digit/pitzi)
 * fall to the generic line. NEVER announces on a silent (proactive-poison) reset; the caller checks
 * d.silent. (agentId is retained in the signature for call-site clarity / future per-agent logic.)
 */
export function notifyMessageFor(agentId, sessionHygiene) {
  return (sessionHygiene && sessionHygiene.notify_message)
    || 'התחלתי שיחה חדשה כדי להישאר חד 🙂 הכל שמור — אפשר להמשיך כרגיל.';
}

/**
 * Resolve everything main() needs from an agent record. The REGISTRY is the single source of truth:
 * the session-hygiene knobs come from `record.sessionHygiene` and the groups from `record.groupIds`
 * (both resolved by shared/lib/agent-registry.mjs from shared/registry.json). The workspace config
 * file is NO LONGER read here — the old `cfg.session_hygiene` merge and `cfg.whatsapp.group_id(s)`
 * fallback (workspace-config-wins) were a silent trap; the registry now owns these facts outright.
 */
export async function resolveAgentWiring(record, { launcher = DEFAULT_LAUNCHER } = {}) {
  const h = { ...(record.sessionHygiene || {}) };
  // ALL groups the agent serves, not just the primary — digit runs in two groups, and a session
  // for group #2 can token-overflow/poison exactly like #1; inspecting only the primary key left
  // it permanently unprotected (same failure class as the 2026-07-01 דאוס outage).
  const groupIds = [...new Set(record.groupIds || [record.primaryGroupId])].filter(Boolean);
  const storePath = path.join(expandHome(record.sessionStore), 'sessions.json');
  const dailyMarker = path.join(record.workspaceDir, 'data', 'session-hygiene-last-daily');
  return {
    agentId: record.agentId,
    config: h,
    groupId: groupIds[0],
    groupIds,
    keyPrefix: `${record.keyPrefix}whatsapp:group:`,
    cronKeyPrefix: `${record.keyPrefix}cron:`,
    storePath,
    dailyMarker,
    launcher,
    notifyMessage: notifyMessageFor(record.agentId, h),
  };
}

// ---------------------------------------------------------------------------
// Real side effects (subprocess) — injectable, kept thin.
// ---------------------------------------------------------------------------

export function makeRunCleanupReal(launcher = DEFAULT_LAUNCHER, agentId) {
  return () => new Promise((resolve) => {
    // `openclaw sessions cleanup` defaults to --agent <configured default> (= main). Without an
    // explicit --agent, a reset for any NON-main bot (zorro/poker/digit/pitzi) used to run cleanup
    // against MAIN's store, never the agent's own — leaving the agent's orphaned entry behind.
    const args = ['sessions', 'cleanup', '--fix-missing', '--enforce'];
    if (agentId) args.splice(2, 0, '--agent', agentId);
    execFile(launcher, args, { timeout: 60000 }, (err) => resolve({ code: err ? (err.code ?? 1) : 0 }));
  });
}

export function makeSendNotifyReal(launcher = DEFAULT_LAUNCHER) {
  return (groupId, msg) => new Promise((resolve) => {
    execFile(launcher, ['message', 'send', '--channel', 'whatsapp', '--target', groupId, '--message', msg],
      { timeout: 20000 }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Orchestration — parameterized by an agent record. Mirrors the original main() exactly,
// with side effects injectable for testing.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.record         agent record from agent-registry.mjs (required)
 * @param {Date}   [opts.now]
 * @param {boolean}[opts.dryRun]
 * @param {boolean}[opts.forceReset]
 * @param {boolean}[opts.forcePoisoned]
 * @param {Function}[opts.log]          (msg) => void; default prefixes "[session-hygiene-<id>]"
 * @param {Function}[opts.runCleanup]   () => {code}; default shells `openclaw sessions cleanup`
 * @param {Function}[opts.sendNotify]   (groupId,msg)=>void; default shells `openclaw message send`
 * @param {string} [opts.launcher]      path to the openclaw launcher
 */
export async function runHygiene({
  record,
  now = new Date(),
  dryRun = false,
  forceReset = false,
  forcePoisoned = false,
  log,
  runCleanup,
  sendNotify,
  launcher = DEFAULT_LAUNCHER,
} = {}) {
  if (!record) throw new Error('runHygiene: record is required');
  const tag = `session-hygiene-${record.agentId}`;
  const logFn = log || ((m) => console.log(`[${tag} ${new Date().toISOString()}] ${m}`));

  const w = await resolveAgentWiring(record, { launcher });
  const h = w.config;
  if (h.enabled === false) { logFn('disabled — skipping'); return { action: 'disabled' }; }
  if (!w.groupIds.length) { logFn('no group_id — abort (rule #1)'); return { action: 'no-group' }; }

  // CRON-SAFETY (root-caused 2026-07-15): never touch this agent's session store while one of its
  // isolated cron runs is in-flight. Any store rewrite here — the per-group delete-rewrite OR the
  // `openclaw sessions cleanup --fix-missing --enforce` that performReset shells — can prune the
  // run's `cron:<uuid>` entry and make the cron finalize throw CronSessionLifecycleClaimError into
  // the group. Defer the WHOLE run (all groups) to the next tick. Read the store once for this gate.
  const cronActiveWindowMs = (h.cron_active_window_secs ?? 1800) * 1000;
  if (!forceReset && !forcePoisoned) {
    try {
      const storeForCron = JSON.parse(await readFile(w.storePath, 'utf8'));
      const activeCronKey = findActiveCronKey(storeForCron, w.cronKeyPrefix, now.getTime(), cronActiveWindowMs);
      if (activeCronKey) {
        logFn(`deferred: cron run active (${activeCronKey}) — skipping all store rewrites this tick`);
        return { action: 'defer', reason: 'cron run active', cronKey: activeCronKey };
      }
    } catch { /* store unreadable/absent — let the per-group pass log it as it does today */ }
  }

  // One pass per group the agent serves (digit has 2). Each group has its own session key, its own
  // transcript, and — for groups beyond the first — its own daily marker (suffixed; the first
  // group keeps the legacy un-suffixed path so existing markers stay valid).
  const runOne = async (groupId, dailyMarker) => {
    const key = w.keyPrefix + groupId;
    const glog = w.groupIds.length > 1 ? (m) => logFn(`[${groupId}] ${m}`) : logFn;

    const store = JSON.parse(await readFile(w.storePath, 'utf8'));
    const sess = resolveGroupSession(store, key);
    if (!sess) { glog('no active group session — nothing to do'); return { action: 'no-session' }; }

    let st; try { st = await stat(sess.sessionFile); }
    catch { glog(`transcript missing (${sess.sessionFile}) — leaving for openclaw cleanup`); return { action: 'transcript-missing' }; }
    const bytes = st.size;
    const nowMs = now.getTime();
    const idle = isIdle(st.mtimeMs, nowMs, h.idle_secs ?? 90);

    const dr = h.daily_reset || {};
    const tz = dr.tz || 'Asia/Jerusalem';
    const jp = jerusalemParts(now, tz);
    const inDailyWindow = (dr.enabled !== false) && isWithinWindow(jp.hh, jp.mm, dr.hour ?? 7, dr.minute ?? 30, dr.span_minutes ?? 10);
    let lastDaily = ''; try { lastDaily = (await readFile(dailyMarker, 'utf8')).trim(); } catch {}
    const dailyAlreadyDone = lastDaily === jp.date;

    const maxBytes = h.max_transcript_bytes ?? 1_000_000;
    // Root-caused 2026-07-15: assistant-only is the NORM since 2026.7.1 (inbound non-mentions no
    // longer reach the session), so it is NOT poison on its own — a merely assistant-only, under-cap
    // session is HEALTHY and must fall through to a noop. It counts as poisoned ONLY when corroborated
    // by a genuine signal (compaction marker, size cap, or entry token-overflow). Token-overflow is
    // also poison on its own and is ORed in below exactly as before.
    let assistantOnly = false, compactionMarker = false;
    try {
      const transcript = await readFile(sess.sessionFile, 'utf8');
      assistantOnly = isPoisoned(transcript);
      compactionMarker = hasCompactionMarker(transcript);
    } catch {}
    const overflowed = isTokenOverflowed(store[key]);
    const sizeOverflow = bytes >= maxBytes;
    const transcriptPoisoned = isTranscriptPoisoned({ assistantOnly, compactionMarker, sizeOverflow, tokenOverflow: overflowed });
    const poisoned = transcriptPoisoned || overflowed;

    const d = decideRun({
      forceReset, forcePoisoned, poisoned, idle,
      bytes, maxBytes, inDailyWindow, dailyAlreadyDone,
    });
    glog(`size=${bytes}B idle=${idle} dailyWindow=${inDailyWindow} dailyDone=${dailyAlreadyDone} force=${forceReset} forcePoisoned=${forcePoisoned} poisoned=${poisoned}(transcript=${transcriptPoisoned}[assistantOnly=${assistantOnly},compactionMarker=${compactionMarker},size=${sizeOverflow}],overflow=${overflowed}) → ${d.reset ? 'RESET' : (d.deferred ? 'DEFER' : 'noop')} (${d.reason})`);
    if (!d.reset) return { action: d.deferred ? 'defer' : 'noop', decision: d };
    if (dryRun) { glog('dry-run — not resetting'); return { action: 'dry-run', decision: d }; }

    const ts = tsStamp(now, tz);
    const cleanup = runCleanup || makeRunCleanupReal(launcher, record.agentId);
    const res = await performReset({ storePath: w.storePath, sessionFile: sess.sessionFile, ts, runCleanup: cleanup, sessionKey: key });
    if (!res.ok) { glog(`RESET FAILED at ${res.stage}: ${res.error} — session left intact`); return { action: 'reset-failed', error: res, decision: d }; }
    if (d.recordDaily) await writeFile(dailyMarker, jp.date);
    glog('reset OK');
    // d.silent -> proactive poison clear: stay quiet (a notify would re-create an assistant-only
    // session and re-poison, and the user saw no error to explain). All other resets still announce.
    if (h.notify_on_reset !== false && !d.silent) {
      const notify = sendNotify || makeSendNotifyReal(launcher);
      await notify(groupId, w.notifyMessage);
    }
    return { action: 'reset', decision: d };
  };

  const results = [];
  for (let i = 0; i < w.groupIds.length; i++) {
    const gid = w.groupIds[i];
    const marker = i === 0 ? w.dailyMarker : `${w.dailyMarker}-${gid}`;
    results.push({ groupId: gid, ...(await runOne(gid, marker)) });
  }
  // Single-group agents keep the historical flat return shape ({action, decision}); multi-group
  // agents get the per-group breakdown plus an aggregate action for coarse consumers.
  if (results.length === 1) return results[0];
  const agg = results.some((r) => r.action === 'reset') ? 'reset'
    : results.some((r) => r.action === 'reset-failed') ? 'reset-failed'
    : results.some((r) => r.action === 'defer') ? 'defer' : 'noop';
  return { action: agg, groups: results };
}

// NOTE: this lib deliberately has NO CLI entry of its own — the ONE entry point is
// shared/tools/session-hygiene.mjs (`--agent <id> | --all`), which the workspace shims and the
// systemd units invoke. (An earlier inline CLI here used a different, untested arg convention and
// was guaranteed to drift; removed 2026-07-02.)
