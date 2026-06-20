#!/usr/bin/env bash
# gateway-watchdog.sh — gateway health watchdog. Runs every 60s (systemd user timer).
# Two independent jobs, sharing one journal scan + group-id resolution + notify path:
#
#   CHECK A — dead agent harness → restart + notify.
#     On 2026-05-26 the gateway PROCESS stayed alive but its agent runtime ("claude-cli")
#     silently de-registered (a WhatsApp reconnect → plugin reload → clearAgentHarnesses(),
#     with no restore on that path). Every inbound msg then fails `MissingAgentHarnessError`
#     and David gets NOTHING; the bot looks dead until restart. systemd never notices.
#     HARDENED 2026-05-27: we no longer restart on the journal signature ALONE — a single
#     stale/transient hit (e.g. during a normal restart's startup window) used to trigger a
#     restart that KILLED whatever message was in flight (the real cause of "the chat crashes
#     when I message it"). Now we first PROBE the harness live; we restart only if the probe
#     ALSO fails. This can never restart more often than before, only less.
#
#   CHECK B — dropped turn → nudge David to resend.
#     When a turn dies (a restart's SIGTERM kills the in-flight `claude -p`, or any transient
#     failure), openclaw logs "failed before reply" / FailoverError and David gets SILENCE —
#     no reply, no error (retry/fallback are null). That silent drop is exactly what David
#     experiences as a "crash". We detect it and send a short "תקלה זמנית, שלח שוב" so a
#     dropped message is never silent — it becomes a one-tap resend.
#
# Scope stays narrow: ONLY a confirmed-dead harness triggers a RESTART (restart only cures a
# lost-harness state; restarting for model/API errors would just thrash). CHECK B never
# restarts — it only notifies.
set -uo pipefail

# Commands are overridable via env so the script is testable with stubs.
OPENCLAW="${OPENCLAW:-/home/davidtobol2580/open_claw/openclaw}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-journalctl}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CONFIG="${CONFIG:-/home/davidtobol2580/open_claw/workspace-jobscout/.config/job-scout.json}"
SERVICE="${SERVICE:-openclaw-gateway.service}"
STATE_DIR="${STATE_DIR:-/home/davidtobol2580/open_claw/workspace-jobscout/data}"
DRYRUN="${WATCHDOG_DRYRUN:-}"        # when set: log instead of restarting/sending (tests)
HEALTH_POLL_SLEEP="${HEALTH_POLL_SLEEP:-5}"  # seconds between post-restart health polls (0 in tests)

COOLDOWN_FILE="$STATE_DIR/watchdog-last-restart"
COOLDOWN_SECS=600          # auto-restart at most once / 10 min — no thrash loops
DEADTURN_COOLDOWN_FILE="$STATE_DIR/watchdog-last-deadturn"
DEADTURN_COOLDOWN_SECS=600 # nudge about dropped turns at most once / 10 min
COMPACT_COOLDOWN_FILE="$STATE_DIR/watchdog-last-compactreset"
COMPACT_COOLDOWN_SECS=600  # recover a compaction-poisoned session at most once / 10 min
WINDOW="90 sec ago"        # scan a touch wider than the 60s tick (overlap, no gaps)
ERR_SIG="MissingAgentHarnessError"
DROP_SIG="failed before reply|claude live session turn failed"
# CHECK C signature: the group session is "poisoned" — OpenClaw decides a preflight compaction
# is required but the transcript has no real user/assistant conversation pairs (only cron-scout
# assistant messages + reset notices), so the compactor refuses and the WHOLE turn aborts with
# outcome=error. David gets the 👍 ack but no reply, and it recurs on every inbound until reset.
# This escapes session-hygiene entirely (it triggers at tiny byte size, far under the size gate).
COMPACT_SIG="Preflight compaction required but failed"
NODE_BIN="${NODE_BIN:-/home/davidtobol2580/.nvm/versions/node/v22.22.3/bin/node}"
SESSION_HYGIENE="${SESSION_HYGIENE:-/home/davidtobol2580/open_claw/workspace-jobscout/tools/session-hygiene.mjs}"

log() { echo "[watchdog $(date -u +%FT%TZ)] $*"; }

# True iff $1 epoch is within $2 seconds of now (cooldown still active).
in_cooldown() {
  local file="$1" secs="$2" now last
  now=$(date +%s)
  [ -f "$file" ] || return 1
  last=$(cat "$file" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$secs" ]
}
record_now() { date +%s > "$1"; }

# Resolve the WhatsApp target from config. NEVER guess a target (hard rule #1): empty on any
# failure, and callers send NOTHING when empty.
resolve_group_id() {
  node -e 'try{process.stdout.write(require(process.argv[1]).whatsapp.group_id||"")}catch(e){}' "$CONFIG" 2>/dev/null
}

# Live harness probe: is the agent runtime actually answering? Returns 0 = healthy.
# Uses the canonical diagnostic the runbook uses to verify the harness. Unhealthy if the
# probe errors, times out, or its output carries the dead-harness signature.
probe_harness() {
  local out rc
  out=$(timeout 25 "$OPENCLAW" agent --session-key diagnostic:harness-check -m "ping" 2>&1); rc=$?
  [ "$rc" -eq 0 ] || return 1
  printf '%s\n' "$out" | grep -q "$ERR_SIG" && return 1
  return 0
}

gateway_healthy() { timeout 15 "$OPENCLAW" health >/dev/null 2>&1; }

send_whatsapp() {  # $1 = group_id, $2 = message
  if [ -n "$DRYRUN" ]; then log "DRYRUN would send to $1: $2"; return 0; fi
  timeout 20 "$OPENCLAW" message send --channel whatsapp --target "$1" --message "$2" >/dev/null 2>&1
}

restart_gateway() {
  if [ -n "$DRYRUN" ]; then log "DRYRUN would restart $SERVICE"; return 0; fi
  timeout 45 "$SYSTEMCTL_BIN" --user restart "$SERVICE" || log "WARN: restart returned non-zero/timed out"
}

# Restart-free recovery for a compaction-poisoned session: reuse session-hygiene's tested reset
# primitive in --force-reset-poisoned mode. NO gateway restart — a fresh small session is
# auto-created on the next inbound. This mode VERIFIES the transcript is genuinely poisoned
# (assistant-only, no real user turns) and then resets it IMMEDIATELY, bypassing the idle-gate:
# a busy WhatsApp group never goes idle, so a plain --force-reset would DEFER forever and leave
# David stuck. If the session turns out NOT to be poisoned, the tool falls back to idle-gating, so
# a healthy-but-busy chat is never interrupted.
force_reset_session() {
  if [ -n "$DRYRUN" ]; then log "DRYRUN would run session-hygiene --force-reset-poisoned"; return 0; fi
  timeout 90 "$NODE_BIN" "$SESSION_HYGIENE" --force-reset-poisoned >/dev/null 2>&1
}

# --- One shared journal read for the recent window. ---------------------------------------
jout=$("$JOURNALCTL_BIN" --user -u "$SERVICE" --since "$WINDOW" --no-pager 2>/dev/null); jrc=$?
if [ "$jrc" -ne 0 ]; then
  log "WARN: journalctl failed (rc=$jrc) — cannot assess health this tick"
  exit 0
fi
GROUP_ID=$(resolve_group_id)

acted_restart=0

# ============================ CHECK A: dead harness → restart =============================
hits=$(printf '%s\n' "$jout" | grep -c "$ERR_SIG" || true)
if [ "${hits:-0}" -gt 0 ]; then
  log "detected ${hits} x ${ERR_SIG} in last 90s — probing harness before acting"
  if probe_harness; then
    log "harness probe OK — signature was transient/stale, NOT restarting"
  elif in_cooldown "$COOLDOWN_FILE" "$COOLDOWN_SECS"; then
    log "harness probe failed but within restart cooldown — skipping"
  else
    # Record cooldown BEFORE the blocking restart so a killed run can't re-restart next tick.
    if ! record_now "$COOLDOWN_FILE"; then
      log "ERROR: cannot write $COOLDOWN_FILE — aborting to avoid thrash"; exit 1
    fi
    log "harness probe FAILED — restarting $SERVICE"
    restart_gateway
    acted_restart=1
    # Confirm recovery (poll), then notify.
    healthy=0
    for _ in 1 2 3 4 5 6; do sleep "$HEALTH_POLL_SLEEP"; if gateway_healthy; then healthy=1; break; fi; done
    if [ -z "$GROUP_ID" ]; then
      log "WARN: no group_id — restarted WITHOUT notifying"
    elif [ "$healthy" -eq 1 ]; then
      log "recovery confirmed — notifying $GROUP_ID"
      send_whatsapp "$GROUP_ID" "⚠️ זיהיתי תקלה אצלי (ה-engine שמריץ אותי נותק) ואתחלתי את עצמי — חזרתי לפעולה, אפשר להמשיך. אם זה חוזר שוב כדאי לבדוק את ה-gateway." || log "WARN: notify send failed"
    else
      log "WARN: health not confirmed after restart — notifying $GROUP_ID"
      send_whatsapp "$GROUP_ID" "⚠️ זיהיתי תקלה אצלי (ה-engine נותק) וניסיתי לאתחל, אבל עדיין לא הצלחתי לאמת שחזרתי. כדאי לבדוק את ה-gateway ידנית." || log "WARN: notify send failed"
    fi
  fi
fi

# ===================== CHECK B: dropped turn → nudge David to resend ======================
# Skip if CHECK A just restarted (that path already messaged David, and the restart itself
# produced the drop signature we'd otherwise double-report).
if [ "$acted_restart" -eq 0 ]; then
  # Count only user/cron-triggered failures — heartbeat failures are internal and
  # should never prompt David to resend (the heartbeat has no user message to resend).
  drops=$(printf '%s\n' "$jout" | awk '
    /trigger=heartbeat/                          { in_hb=1; next }
    /cli exec:/                                  { in_hb=0 }
    /claude live session turn failed|failed before reply/ { if (!in_hb) count++ }
    END { print count+0 }
  ' || true)
  if [ "${drops:-0}" -gt 0 ]; then
    if in_cooldown "$DEADTURN_COOLDOWN_FILE" "$DEADTURN_COOLDOWN_SECS"; then
      log "detected ${drops} dropped turn(s) but within dead-turn cooldown — not nudging"
    elif [ -z "$GROUP_ID" ]; then
      log "detected ${drops} dropped turn(s) but no group_id — cannot nudge"
    elif ! gateway_healthy; then
      log "detected ${drops} dropped turn(s) but gateway not healthy yet — deferring nudge"
    else
      record_now "$DEADTURN_COOLDOWN_FILE" || log "WARN: cannot write $DEADTURN_COOLDOWN_FILE"
      log "detected ${drops} dropped turn(s) — nudging $GROUP_ID to resend"
      send_whatsapp "$GROUP_ID" "⚠️ אופס, נראה שההודעה האחרונה שלך נפלה אצלי בגלל תקלה זמנית ולא הספקתי לענות. תשלח אותה שוב בבקשה 🙏" || log "WARN: nudge send failed"
    fi
  fi
fi

# ============== CHECK C: compaction-poisoned session → force-reset + nudge =================
# NEVER restarts the gateway (the failure is per-session, not per-process). Resets the poisoned
# session via session-hygiene's idle-gated primitive, then nudges David to resend his message.
if [ "$acted_restart" -eq 0 ]; then
  poisoned=$(printf '%s\n' "$jout" | grep -cF "$COMPACT_SIG" || true)
  if [ "${poisoned:-0}" -gt 0 ]; then
    if in_cooldown "$COMPACT_COOLDOWN_FILE" "$COMPACT_COOLDOWN_SECS"; then
      log "detected ${poisoned} x compaction-poison but within cooldown — skipping reset"
    else
      record_now "$COMPACT_COOLDOWN_FILE" || log "WARN: cannot write $COMPACT_COOLDOWN_FILE"
      log "detected ${poisoned} x '${COMPACT_SIG}' — force-resetting poisoned session (restart-free)"
      force_reset_session
      if [ -z "$GROUP_ID" ]; then
        log "WARN: reset done but no group_id — cannot nudge"
      else
        send_whatsapp "$GROUP_ID" "⚠️ הייתה לי תקלה זמנית בשיחה ולא הספקתי לענות. אתחלתי את עצמי — תשלח את ההודעה האחרונה שוב בבקשה 🙏" || log "WARN: nudge send failed"
      fi
    fi
  fi
fi

exit 0
