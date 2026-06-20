#!/usr/bin/env node
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";

const CONFIG = "/home/davidtobol2580/open_claw/workspace-jobscout/.config/job-scout.json";
const STORE = "/home/davidtobol2580/.openclaw/agents/main/sessions/sessions.json";
const LAUNCHER = "/home/davidtobol2580/open_claw/openclaw";
const DAILY_MARKER = "/home/davidtobol2580/open_claw/workspace-jobscout/data/session-hygiene-last-daily";
const KEY_PREFIX = "agent:main:whatsapp:group:";

export function resolveGroupSession(store, key) {
  const e = store?.[key];
  if (!e || !e.sessionId || !e.sessionFile) return null;
  return { sessionId: e.sessionId, sessionFile: e.sessionFile };
}
export function isIdle(mtimeMs, nowMs, idleSecs) {
  return (nowMs - mtimeMs) >= idleSecs * 1000;
}
/**
 * A "compaction-poisoned" transcript: it carries assistant turns (cron-scout reports, reset
 * notices) but ZERO real user messages, so OpenClaw's preflight compactor refuses ("no real
 * conversation messages") and aborts every inbound turn. Such a session can NEVER recover on its
 * own and resetting it interrupts no live conversation — so the recovery path may bypass the
 * idle-gate even in a busy group. We bypass ONLY when this returns true (defence against ever
 * killing a session that has genuine user turns). Each line is one JSON record; the role lives at
 * `.message.role` or `.role` or `.type`.
 */
export function isPoisoned(transcriptText) {
  let users = 0, assistants = 0;
  for (const line of String(transcriptText).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const role = o?.message?.role || o?.role || o?.type;
    if (role === "user") users++;
    else if (role === "assistant") assistants++;
  }
  return users === 0 && assistants > 0;
}
export function isWithinWindow(hh, mm, winH, winM, spanMin) {
  const cur = hh * 60 + mm, start = winH * 60 + winM;
  return cur >= start && cur < start + spanMin;
}
/**
 * Decision for the watchdog recovery modes (--force-reset / --force-reset-poisoned). Pure so it can
 * be unit-tested. The whole point of the poison fix: a confirmed-poisoned session resets EVEN WHEN
 * NOT IDLE (a busy group never idles), while every other path still respects the idle-gate.
 */
export function decideForce({ forceReset, forcePoisoned, poisoned, idle }) {
  if (forcePoisoned && poisoned) return { reset: true, deferred: false, recordDaily: false, reason: "poisoned session — reset (idle-gate bypassed)" };
  return idle
    ? { reset: true, deferred: false, recordDaily: false, reason: forcePoisoned ? "force-reset (not poisoned, idle)" : "force-reset" }
    : { reset: false, deferred: true, recordDaily: false, reason: forcePoisoned ? "not poisoned & busy — deferred" : "force-reset requested but session busy — deferred" };
}
export function decide({ bytes, maxBytes, idle, inDailyWindow, dailyAlreadyDone }) {
  const sizeHit = bytes >= maxBytes;
  const dailyHit = inDailyWindow && !dailyAlreadyDone;
  if (!sizeHit && !dailyHit) return { reset: false, deferred: false, recordDaily: false, reason: `ok (${bytes}B)` };
  if (!idle) return { reset: false, deferred: true, recordDaily: false, reason: "trigger met but session busy — deferred" };
  return { reset: true, deferred: false, recordDaily: dailyHit, reason: sizeHit ? `size ${bytes}>=${maxBytes}B` : "daily window" };
}

/**
 * PROACTIVE poison self-heal — the root-cause fix for the recurring morning breakage.
 * The 08:00 cron scout delivers its per-person reports into the group's CONVERSATIONAL session
 * as assistant turns, leaving it user=0 / assistant>0. Such a session kills the NEXT turn that
 * needs preflight compaction ("no real conversation messages") — i.e. the first non-trivial
 * thing David types that day. The 07:30 daily reset runs BEFORE the scout, so it never helps.
 * So on EVERY regular hygiene run, if the live session is assistant-only, clear it NOW —
 * before David ever hits the error — instead of only waiting for the reactive watchdog (CHECK C).
 *   • SILENT: a "started a new conversation" notify would itself create a fresh assistant-only
 *     session and re-poison it (infinite reset↔notify loop). David saw no error, so there is
 *     nothing to announce — the chat just stays healthy.
 *   • Idle-gate BYPASSED: users===0 means there is no human conversation to interrupt; the
 *     session is already broken for any compaction-needing turn (same rationale as forcePoisoned).
 * Pure so it is unit-tested. Returns a decision shaped like decide()/decideForce().
 */
export function decideProactivePoison({ poisoned }) {
  return poisoned
    ? { reset: true, deferred: false, recordDaily: false, silent: true, reason: "proactive: assistant-only session (poisoned) — clearing silently" }
    : { reset: false, deferred: false, recordDaily: false, silent: true, reason: "not poisoned — noop" };
}

/**
 * Atomic, restart-free reset: backup store → archive transcript → prune orphan via openclaw.
 * Order matters: the entry is pruned by openclaw's own command AFTER the file is archived, so the
 * missing-file-but-entry-kept state can never persist. Aborts on any error before cleanup,
 * leaving an intact (if large) session rather than a broken one.
 */
export async function performReset({ storePath, sessionFile, ts, runCleanup }) {
  try {
    const backup = await readFile(storePath, "utf8");
    await writeFile(`${storePath}.bak-${ts}`, backup);
    await rename(sessionFile, `${sessionFile}.archived-${ts}`); // throws if missing → abort, no cleanup
  } catch (e) {
    return { ok: false, stage: "archive", error: String(e?.message || e) };
  }
  const r = await runCleanup();
  return r?.code === 0 ? { ok: true } : { ok: false, stage: "cleanup", error: `cleanup code ${r?.code}` };
}

function jerusalemParts(now, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}
function tsStamp(now, tz) {
  const { date, hh, mm } = jerusalemParts(now, tz);
  return `${date.replace(/-/g, "")}-${String(hh).padStart(2,"0")}${String(mm).padStart(2,"0")}00`;
}
function runCleanupReal() {
  return new Promise((resolve) => {
    execFile(LAUNCHER, ["sessions", "cleanup", "--fix-missing", "--enforce"],
      { timeout: 60000 }, (err) => resolve({ code: err ? (err.code ?? 1) : 0 }));
  });
}
function sendNotify(groupId, msg) {
  return new Promise((resolve) => {
    execFile(LAUNCHER, ["message", "send", "--channel", "whatsapp", "--target", groupId, "--message", msg],
      { timeout: 20000 }, () => resolve());
  });
}
function log(m) { console.log(`[session-hygiene ${new Date().toISOString()}] ${m}`); }

export async function main({ now = new Date(), dryRun = false, forceReset = false, forcePoisoned = false } = {}) {
  const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  const h = cfg.session_hygiene || {};
  if (h.enabled === false) { log("disabled — skipping"); return; }
  const groupId = cfg?.whatsapp?.group_id;
  if (!groupId) { log("no group_id — abort (rule #1)"); return; }
  const key = KEY_PREFIX + groupId;

  const store = JSON.parse(await readFile(STORE, "utf8"));
  const sess = resolveGroupSession(store, key);
  if (!sess) { log("no active group session — nothing to do"); return; }

  let st; try { st = await stat(sess.sessionFile); }
  catch { log(`transcript missing (${sess.sessionFile}) — leaving for openclaw cleanup`); return; }
  const bytes = st.size;
  const nowMs = now.getTime();
  const idle = isIdle(st.mtimeMs, nowMs, h.idle_secs ?? 90);

  const dr = h.daily_reset || {};
  const tz = dr.tz || "Asia/Jerusalem";
  const jp = jerusalemParts(now, tz);
  const inDailyWindow = isWithinWindow(jp.hh, jp.mm, dr.hour ?? 7, dr.minute ?? 30, dr.span_minutes ?? 10);
  let lastDaily = ""; try { lastDaily = (await readFile(DAILY_MARKER, "utf8")).trim(); } catch {}
  const dailyAlreadyDone = lastDaily === jp.date;

  // forcePoisoned (watchdog CHECK C recovering a compaction-poisoned session): a busy WhatsApp
  // GROUP never goes idle (constant inbound + 👍 reactions touch the transcript), so an idle-gated
  // reset would DEFER forever — exactly when David is actively trying to chat. A confirmed-poisoned
  // session is already broken (every turn errors before the LLM runs) and has no live conversation
  // to interrupt, so we reset it IMMEDIATELY, bypassing the idle-gate. We verify poison from the
  // transcript itself first; if it is NOT actually poisoned we fall back to idle-gated behaviour so
  // a healthy-but-busy session is never killed.
  // ALWAYS check for the assistant-only poison (cheap — the transcript is small). This is the
  // recurring morning failure: the 08:00 cron scout's reports land here as assistant-only turns,
  // and the next compaction-needing turn dies. We heal it proactively on the regular timer.
  let poisoned = false;
  try { poisoned = isPoisoned(await readFile(sess.sessionFile, "utf8")); } catch {}

  // forceReset (manual --force-reset): reset regardless of size/daily triggers, but STILL idle-gate
  // so a live chat is never interrupted. forcePoisoned bypasses the idle-gate ONLY when confirmed
  // poisoned (see decideForce). A plain run on an assistant-only session → proactive SILENT heal.
  const d = (forceReset || forcePoisoned)
    ? decideForce({ forceReset, forcePoisoned, poisoned, idle })
    : poisoned
      ? decideProactivePoison({ poisoned })
      : decide({ bytes, maxBytes: h.max_transcript_bytes ?? 1_000_000, idle, inDailyWindow, dailyAlreadyDone });
  log(`size=${bytes}B idle=${idle} dailyWindow=${inDailyWindow} dailyDone=${dailyAlreadyDone} force=${forceReset} forcePoisoned=${forcePoisoned} poisoned=${poisoned} → ${d.reset ? "RESET" : (d.deferred ? "DEFER" : "noop")} (${d.reason})`);
  if (!d.reset) return;
  if (dryRun) { log("dry-run — not resetting"); return; }

  const ts = tsStamp(now, tz);
  const res = await performReset({ storePath: STORE, sessionFile: sess.sessionFile, ts, runCleanup: runCleanupReal });
  if (!res.ok) { log(`RESET FAILED at ${res.stage}: ${res.error} — session left intact`); return; }
  if (d.recordDaily) await writeFile(DAILY_MARKER, jp.date);
  log("reset OK");
  // d.silent → a proactive poison clear: stay quiet (a notify would re-create an assistant-only
  // session and re-poison, and David saw no error to explain). All other resets still announce.
  if (h.notify_on_reset !== false && !d.silent) {
    await sendNotify(groupId, "התחלתי שיחה חדשה כדי להישאר חד 🙂 כל המעקב והמשרות שמורים — אפשר להמשיך כרגיל.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main({
    dryRun: process.argv.includes("--dry-run"),
    forceReset: process.argv.includes("--force-reset"),
    forcePoisoned: process.argv.includes("--force-reset-poisoned"),
  }).catch((e) => { log(`fatal: ${e?.message || e}`); process.exit(1); });
}
