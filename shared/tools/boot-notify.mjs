#!/usr/bin/env node
// Post-reboot notifier.
// After a REAL machine reboot, waits for the OpenClaw gateway + WhatsApp to be
// ready, then sends David one Hebrew status message in the Job Scout group
// explaining what happened (so a host reboot is never mistaken for an agent crash).
//
// Wired as a systemd --user oneshot: After=openclaw-gateway.service,
// WantedBy=default.target -> fires once per boot, NOT on a gateway restart.
//
// Idempotency: keyed on the kernel boot time (btime from /proc/stat), persisted in
// a state file. A second run within the same boot (e.g. a manual service restart)
// is a no-op. /tmp is NOT tmpfs here, so we do NOT rely on /tmp being wiped.
//
// Flags:
//   --dry-run   compose + print the message and target, send nothing, exit 0.
//
// Exit codes: 0 = sent (or already-sent this boot, or dry-run); 1 = gave up after retries.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { getAgent, listAgents, isPlaceholderJid } from '../lib/agent-registry.mjs';
import { launcherPath } from '../lib/paths.mjs';
import { displayInTz } from '../lib/time.mjs';

const HOME = process.env.HOME || homedir();
const OPENCLAW = launcherPath;
const STATE_FILE = `${HOME}/.openclaw/boot-notify.state`;
const TZ = 'Asia/Jerusalem';
const DRY = process.argv.includes('--dry-run');

const MAX_ATTEMPTS = 60;       // up to ~20 min of waiting for WhatsApp to connect
const RETRY_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// --- resolve target group (David's Job Scout group = the owner channel) ---
// The registry (shared/registry.json) is the single source of truth for the wiring. NEVER a
// hardcoded guess (hard rule #1): if the registry is unreadable or carries only a placeholder jid
// we send NOTHING and exit non-zero. The old workspace-config fallbacks (job-scout.json
// whatsapp.group_id / people.json shared.whatsapp_group_id) were removed 2026-07-17 — those wiring
// fields no longer live in the configs.
function resolveGroup() {
  try {
    const rec = getAgent('main');
    if (!isPlaceholderJid(rec?.primaryGroupId)) return rec.primaryGroupId;
  } catch { /* registry unreadable -> send nothing */ }
  return '';
}

// --- kernel boot time = stable per-boot id ---
function bootId() {
  const m = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

function fmt(epochSec) {
  return displayInTz(new Date(epochSec * 1000), { tz: TZ });
}

// --- best-effort: was the PREVIOUS shutdown graceful (planned) or abrupt (crash)? ---
function shutdownNote() {
  try {
    const prev = execSync('journalctl --user -b -1 -n 120 --no-pager 2>/dev/null', {
      encoding: 'utf8', timeout: 15_000,
    });
    if (!prev.trim()) return '';
    if (/SIGTERM received|received SIGTERM|gateway stopping|Stopping .*openclaw/i.test(prev)) {
      return 'הכיבוי הקודם היה מסודר — ככל הנראה אתחול יזום (תחזוקה/מנהל השרת), לא קריסה.';
    }
    return 'הכיבוי הקודם לא נראה מסודר — ייתכן קריסה או הפסקת חשמל פתאומית.';
  } catch { return ''; }
}

// The live bot list comes from the registry — the old hardcoded string went stale the day
// zorro launched and nobody remembered to update it here.
function agentNames() {
  try {
    const names = listAgents().map((a) => a?.persona?.name || a.agentId).filter(Boolean);
    if (names.length) return names.join(', ');
  } catch { /* registry unreadable */ }
  return 'כל הבוטים';
}

function composeMessage() {
  const bid = bootId();
  const bootStr = bid ? fmt(bid) : 'לא ידוע';
  const note = shutdownNote();
  const para = [
    '🔄 *המערכת עלתה מחדש אחרי reboot*',
    `השרת (המכונה כולה) עבר אתחול בסביבות ${bootStr}.` + (note ? ' ' + note : ''),
    'כל הסוכנים חזרו לפעול אוטומטית ✅ — ' + agentNames() + '.\n' +
      'אם אחד מהם הפסיק להגיב בסביבות אותה שעה — זו הסיבה (אתחול של כל ההוסט המשותף), ולא תקלה בסוכן עצמו.',
  ];
  return para.join('\n\n');
}

async function main() {
  const group = resolveGroup();
  if (!group) {
    console.error('no resolvable target group (registry + configs unreadable) — sending NOTHING (never guess a target)');
    process.exit(1);
  }
  const msg = composeMessage();
  const bid = bootId();

  if (DRY) {
    console.log(`[dry-run] target group: ${group}`);
    console.log(`[dry-run] boot id (btime): ${bid}`);
    console.log('[dry-run] message:\n' + msg);
    process.exit(0);
  }

  // idempotency: already notified for this boot?
  if (bid != null && existsSync(STATE_FILE)) {
    const prev = (readJson(STATE_FILE) || {}).bootId;
    if (prev === bid) {
      console.log(`already notified for boot ${bid}; nothing to do`);
      process.exit(0);
    }
  }

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      execFileSync(OPENCLAW, ['message', 'send', '--channel', 'whatsapp', '--target', group, '--message', msg], {
        stdio: 'ignore', timeout: 60_000,
      });
      try { writeFileSync(STATE_FILE, JSON.stringify({ bootId: bid, sentAt: new Date().toISOString() })); } catch {}
      console.log(`boot notice sent to ${group} (attempt ${i})`);
      process.exit(0);
    } catch (e) {
      // gateway / WhatsApp not ready yet — wait and retry
      if (i < MAX_ATTEMPTS) await sleep(RETRY_MS);
    }
  }
  console.error(`gave up after ${MAX_ATTEMPTS} attempts; WhatsApp never became ready`);
  process.exit(1);
}

main();
