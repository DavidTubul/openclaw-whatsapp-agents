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
#   CHECK B — REMOVED 2026-06-27 (David's request: "תתקן שלא ישלח את זה יותר").
#     It used to detect a dropped turn ("failed before reply"/FailoverError) and send David
#     "⚠️ אופס… ההודעה נפלה… תשלח שוב 🙏". By 2026-06-27 the dominant cause (a failing 30-min
#     heartbeat) was already fixed (HEARTBEAT.md → comments-only, 2026-06-22), so the remaining
#     nudges were either (a) genuine but rare Anthropic 500/529 outages, or (b) self-inflicted
#     restart-mid-reply churn from config tuning while David chatted — where a "resend" nudge is
#     pure noise (he'd just resend into the next restart). David opted to drop the nudge entirely:
#     a silently-dropped turn is now simply silent (he can tell it didn't answer and resends on
#     his own). CHECK A (dead harness) and CHECK C (compaction-poisoned session) are unaffected.
#
# Scope stays narrow: ONLY a confirmed-dead harness triggers a RESTART (restart only cures a
# lost-harness state; restarting for model/API errors would just thrash).
set -uo pipefail

# Repo root derived from this script's location (shared/tools/ -> shared/ -> repo root).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/../.. && pwd)"

# Commands are overridable via env so the script is testable with stubs.
OPENCLAW="${OPENCLAW:-$REPO_ROOT/openclaw}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-journalctl}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
SERVICE="${SERVICE:-openclaw-gateway.service}"
# Fleet-level state (cooldown files) lives under shared/ — this is a multi-agent watchdog, not
# Scotty's. Old per-file state migrated from workspace-jobscout/data on 2026-07-02.
STATE_DIR="${STATE_DIR:-$REPO_ROOT/shared/.state}"
DRYRUN="${WATCHDOG_DRYRUN:-}"        # when set: log instead of restarting/sending (tests)
HEALTH_POLL_SLEEP="${HEALTH_POLL_SLEEP:-5}"  # seconds between post-restart health polls (0 in tests)

COOLDOWN_FILE="$STATE_DIR/watchdog-last-restart"
COOLDOWN_SECS=600          # auto-restart at most once / 10 min — no thrash loops
# Per-agent compaction-reset cooldown files are "$STATE_DIR/watchdog-last-compactreset-<agentId>".
COMPACT_COOLDOWN_SECS=600  # recover each agent's poisoned session at most once / 10 min
WINDOW="90 sec ago"        # scan a touch wider than the 60s tick (overlap, no gaps)
ERR_SIG="MissingAgentHarnessError"
# CHECK C signature: a group session is "poisoned" — its session ENTRY's token count has run PAST
# the context window (entry.totalTokens > entry.contextTokens, e.g. days of daily-cron assistant
# posts with no hygiene reset), so OpenClaw demands a preflight compaction, but the transcript has
# no real user/assistant conversation pairs to summarize → the compactor refuses and the WHOLE turn
# aborts with outcome=error. The user gets the 👍 ack but no reply, and it recurs on EVERY inbound
# until the session ENTRY is reset. Archiving the transcript is NOT enough (the killer state is on
# the entry; verified 2026-06-29 on זורו: empty transcript, every turn still aborted). The shared
# reset (shared/lib/session-hygiene performReset) now DELETES the entry, so a fresh 0-token session
# is created on the next inbound.
#
# ⚠️ 2026-06-29 — MULTI-AGENT. The gateway journal is SHARED by every bot, but this used to be
# Scotty-only: it force-reset MAIN's session and posted "⚠️ תקלה זמנית… תשלח שוב" to MAIN's group
# whenever ANY agent was poisoned (root cause of David's "סקוטי שולח את זה מדי פעם ואני לא יודע
# למה" — verified: זורו was the poisoned one, סקוטי apologized). Now CHECK C heals EACH agent in
# its OWN context: for every registered agent whose own sessionKey carries the signature, it runs
# the shared per-agent reset, which posts THAT bot's own reassuring "started a fresh chat,
# everything saved" notice. The confusing "resend" nudge is GONE. CHECK A (dead harness) stays
# GLOBAL — a process-wide failure cured only by a restart.
COMPACT_SIG="Preflight compaction required but failed"
REGISTRY_JSON="${REGISTRY_JSON:-$REPO_ROOT/shared/registry.json}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
# The SHARED, registry-driven session-hygiene CLI: `--agent <id> --force-reset-poisoned`.
SESSION_HYGIENE="${SESSION_HYGIENE:-$REPO_ROOT/shared/tools/session-hygiene.mjs}"

# CHECK D — the self-heal stack itself had no defender: openclaw-reflect.service failed silently
# for 5 straight nights (a one-line PATH bug), and the 2026-06-16 203/EXEC rename incident killed
# the hygiene timers with zero signal. Any failed openclaw-* user unit now notifies David.
FAILED_UNITS_COOLDOWN_SECS=21600   # 6h — a broken unit stays broken; don't page every minute
FAILED_UNITS_CMD="${FAILED_UNITS_CMD:-\"\$SYSTEMCTL_BIN\" --user --failed --plain --no-legend 'openclaw-*' 2>/dev/null | awk '{print \$1}'}"

# CHECK E — the vendored NON-STOCK patches are silently reverted by any `npm i -g openclaw` /
# `openclaw update` / plugin reinstall (RUNBOOK lists them: ghost-mode, per-conversation-serialization,
# inbound-hook-emit in the monitor bundle + the cliBackends config key). Verified 2026-07-02: the
# selection-guard patch was ALREADY missing from the installed dist (an earlier upgrade wiped it;
# only the config-side `cliBackends` fix kept the bots alive). Sentinel-grep the load-bearing
# markers and notify David when one disappears, instead of rediscovering it mid-outage.
SENTINEL_COOLDOWN_SECS=86400       # 24h
# ⚠️ The WhatsApp plugin RENAMES this bundle on every build (monitor-ClhD-fQ6.js → monitor-DD8bXohk.js
# → …), so a hardcoded name goes stale after any upgrade and CHECK E falsely reports
# `whatsapp-monitor-file-missing` instead of grepping the sentinels (found 2026-07-15). Resolve the
# CURRENT bundle by glob (newest monitor-*.js by mtime) so it keeps working across future renames.
# Still overridable via the MONITOR_JS env var (tests stub it).
WHATSAPP_DIST="${WHATSAPP_DIST:-$HOME/.openclaw/extensions/whatsapp/dist}"
resolve_monitor_js() { ls -1t "$WHATSAPP_DIST"/monitor-*.js 2>/dev/null | head -n1; }
MONITOR_JS="${MONITOR_JS:-$(resolve_monitor_js)}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

# CHECK F — registry drift. `registry-sync.mjs --check --json` compares shared/registry.json against
# the LIVE openclaw.json + the live cron delivery targets (exit 0 in-sync / 1 on drift; --json prints
# {ok, driftCount, ...}). It shells the openclaw CLI for the cron list (~6s boot), so this is the ONE
# expensive check — THROTTLE it to once / 30 min via its own run-cooldown (skipped silently otherwise),
# and on drift notify the owner group at most once / 6h (separate notify-cooldown) while still logging
# the drift on every throttled-in run. A tool failure (non-0/1 exit, missing node, crash) is a logged
# WARN only — never notifies and never fails the watchdog run (best-effort, like the other checks).
# REGISTRY_SYNC_CMD is env-overridable (like FAILED_UNITS_CMD) so the harness can stub registry-sync.
REGISTRY_SYNC="${REGISTRY_SYNC:-$REPO_ROOT/shared/tools/registry-sync.mjs}"
REGISTRY_SYNC_CMD="${REGISTRY_SYNC_CMD:-\"\$NODE_BIN\" \"\$REGISTRY_SYNC\" --check --json}"
RS_CHECK_COOLDOWN_SECS=1800    # 30 min — registry-sync shells the openclaw CLI (~6s); don't run every tick
RS_NOTIFY_COOLDOWN_SECS=21600  # 6h — a drift stays drift; don't page every 30 min

log() { echo "[watchdog $(date -u +%FT%TZ)] $*"; }
mkdir -p "$STATE_DIR" 2>/dev/null || true

# True iff $1 epoch is within $2 seconds of now (cooldown still active).
in_cooldown() {
  local file="$1" secs="$2" now last
  now=$(date +%s)
  [ -f "$file" ] || return 1
  last=$(cat "$file" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$secs" ]
}
record_now() { date +%s > "$1"; }

# Resolve the WhatsApp notify target — main's (Scotty's) primary group — from the REGISTRY
# (shared/registry.json via the agent-registry loader), the single source of truth. NEVER guess a
# target (hard rule #1): empty on any failure, and callers send NOTHING when empty. Overridable via
# WATCHDOG_GROUP_ID so the test harness can inject a group without the live registry.
resolve_group_id() {
  if [ -n "${WATCHDOG_GROUP_ID:-}" ]; then printf '%s' "$WATCHDOG_GROUP_ID"; return; fi
  "$NODE_BIN" -e 'import(process.argv[1]).then(m=>process.stdout.write(m.getAgent("main")?.primaryGroupId||"")).catch(()=>{})' "$REPO_ROOT/shared/lib/agent-registry.mjs" 2>/dev/null
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

# Enumerate the agents to heal: every registry agent that has a sessionHygiene block. Routed through
# the agent-registry loader (same mechanism as resolve_group_id) — NOT a raw parse of registry.json —
# so it honours the registry.example.json fresh-clone fallback and, critically, EXCLUDES archived
# agents (listAgents() filters `archived:true`, so a retired bot like pitzi is never a heal target).
# Overridable via LIST_AGENTS_CMD so tests don't depend on the live registry.
list_agents() {
  if [ -n "${LIST_AGENTS_CMD:-}" ]; then eval "$LIST_AGENTS_CMD"; return; fi
  "$NODE_BIN" -e 'import(process.argv[1]).then(m=>{for(const a of m.listAgents()){if(a.sessionHygiene)process.stdout.write(a.agentId+"\n")}}).catch(()=>{})' "$REPO_ROOT/shared/lib/agent-registry.mjs" 2>/dev/null
}

# Restart-free, agent-scoped recovery for a compaction-poisoned session, via the SHARED reset
# primitive in --force-reset-poisoned mode. NO gateway restart — the failure is per-session, and the
# reset DELETES the over-window session entry so a fresh 0-token session is auto-created on the next
# inbound. --force-reset-poisoned VERIFIES the session is genuinely poisoned and resets it
# immediately (bypassing the idle-gate — a busy group never idles); if NOT poisoned it falls back to
# idle-gating, so a healthy chat is never interrupted. The shared lib posts that agent's own
# reassuring reset notice; the watchdog itself sends nothing.
reset_agent_session() {  # $1 = agentId
  if [ -n "$DRYRUN" ]; then log "DRYRUN would run session-hygiene --agent $1 --force-reset-poisoned"; return 0; fi
  # Surface the lib's own decision instead of assuming success — root-caused 2026-07-01 (poker/דאוס):
  # the caller used to log "force-resetting" unconditionally and discard this output, so a tick where
  # the session-hygiene lib actually DEFERRED (not idle, and its own poisoned-check said no) looked
  # identical in the journal to a real reset — the incident sat broken for ~40 min with the log lying
  # about it the whole time. Log the real RESET/DEFER/noop line so a future recurrence is diagnosable.
  local out rc
  out=$(timeout 90 "$NODE_BIN" "$SESSION_HYGIENE" --agent "$1" --force-reset-poisoned 2>&1)
  rc=$?
  printf '%s\n' "$out" | grep -E '→ (RESET|DEFER|noop)|reset OK|RESET FAILED' | while IFS= read -r line; do
    log "session-hygiene[$1]: $line"
  done
  return "$rc"
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

# CHECK B (dropped turn → "resend" nudge) was REMOVED 2026-06-27 — see the header note.

# ============== CHECK C: compaction-poisoned session(s) → per-agent force-reset =================
# Never restarts the gateway (per-session, not per-process). Heals EVERY agent whose OWN session
# shows the poison signature, scoped by its sessionKey, on a per-agent cooldown. No "resend" nudge —
# the reset posts that bot's own reassuring notice (see CHECK C note above).
if [ "$acted_restart" -eq 0 ] && printf '%s\n' "$jout" | grep -qF "$COMPACT_SIG"; then
  while IFS= read -r aid; do
    [ -n "$aid" ] || continue
    cnt=$(printf '%s\n' "$jout" | grep -F "$COMPACT_SIG" | grep -cF "sessionKey=agent:${aid}:" || true)
    [ "${cnt:-0}" -gt 0 ] || continue
    cdfile="$STATE_DIR/watchdog-last-compactreset-${aid}"
    if in_cooldown "$cdfile" "$COMPACT_COOLDOWN_SECS"; then
      log "detected ${cnt} x compaction-poison for agent '${aid}' but within cooldown — skipping"
      continue
    fi
    record_now "$cdfile" || log "WARN: cannot write $cdfile"
    log "detected ${cnt} x '${COMPACT_SIG}' for agent '${aid}' — attempting restart-free session reset"
    reset_agent_session "$aid"
  done <<EOF
$(list_agents)
EOF
fi

# ================== CHECK D: failed openclaw-* systemd units → notify David =====================
# Detection-only (no auto-restart of arbitrary units — a failing unit usually needs a code/config
# fix, and blind restarts would just churn). One WhatsApp notice per 6h while anything is failed.
failed_units=$(eval "$FAILED_UNITS_CMD" | grep -v '^$' || true)
if [ -n "$failed_units" ]; then
  fu_line=$(printf '%s' "$failed_units" | tr '\n' ' ')
  cdfile="$STATE_DIR/watchdog-last-failedunits"
  if in_cooldown "$cdfile" "$FAILED_UNITS_COOLDOWN_SECS"; then
    log "failed units present ($fu_line) but within cooldown — skipping notify"
  else
    record_now "$cdfile" || log "WARN: cannot write $cdfile"
    log "FAILED openclaw units detected: $fu_line — notifying"
    if [ -n "$GROUP_ID" ]; then
      send_whatsapp "$GROUP_ID" "🛠️ בדיקת תשתית: יחידות systemd של OpenClaw במצב failed: ${fu_line}. הבוטים אולי עובדים, אבל שכבת התחזוקה הזו מתה בשקט — שווה להריץ: systemctl --user status <unit> ו-journalctl --user -u <unit>." || log "WARN: notify send failed"
    else
      log "WARN: no group_id — failed-units NOT notified"
    fi
  fi
fi

# ================== CHECK E: vendored-patch sentinels → notify David ============================
# Each marker is the load-bearing symbol a patch introduces (or, for the harness fix, the config
# key that routes around the stock throw). Missing marker = an upgrade reverted it.
missing_patches=""
if [ -f "$MONITOR_JS" ]; then
  grep -qF '__serializePerConversation' "$MONITOR_JS" || missing_patches="${missing_patches}per-conversation-serialization "
  grep -qF 'Promise.resolve(s.sendPresenceUpdate("unavailable"))' "$MONITOR_JS" || missing_patches="${missing_patches}ghost-mode "
  grep -qF '[inbound-hook-emit]' "$MONITOR_JS" || missing_patches="${missing_patches}inbound-hook-emit "
  grep -qF '[inbound-hook-mention]' "$MONITOR_JS" || missing_patches="${missing_patches}inbound-hook-mention "
else
  missing_patches="${missing_patches}whatsapp-monitor-file-missing "
fi
if [ -f "$OPENCLAW_CONFIG" ]; then
  "$NODE_BIN" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c.agents&&c.agents.defaults&&c.agents.defaults.cliBackends&&c.agents.defaults.cliBackends["claude-cli"]?0:1)' "$OPENCLAW_CONFIG" 2>/dev/null \
    || missing_patches="${missing_patches}cliBackends-config "
fi
if [ -n "$missing_patches" ]; then
  cdfile="$STATE_DIR/watchdog-last-sentinel"
  if in_cooldown "$cdfile" "$SENTINEL_COOLDOWN_SECS"; then
    log "vendored-patch sentinel failing ($missing_patches) but within cooldown — skipping notify"
  else
    record_now "$cdfile" || log "WARN: cannot write $cdfile"
    log "vendored-patch sentinel FAILED: $missing_patches— notifying"
    if [ -n "$GROUP_ID" ]; then
      send_whatsapp "$GROUP_ID" "🛠️ בדיקת תשתית: פאצ'ים ידניים של OpenClaw נמחקו (כנראה שדרוג): ${missing_patches}. להחיל מחדש לפי docs/RUNBOOK.md — בלעדיהם חוזרים באגים ידועים (הודעות שנבלעות בין שולחים / נוטיפיקציות בטלפון)." || log "WARN: notify send failed"
    fi
  fi
fi

# ============= CHECK F: registry drift (registry.json vs live openclaw.json + cron targets) =============
# Best-effort + throttled: the check runs at most once / 30 min (its ~6s CLI shell must stay off the 60s
# hot path). On genuine drift (exit 1) log the count on every run that gets through the throttle and
# WhatsApp-notify the owner group once / 6h. A tool failure (any non-0/1 exit) is logged and swallowed —
# no notify, never fails the run.
rs_check_cd="$STATE_DIR/watchdog-last-registrycheck"
if in_cooldown "$rs_check_cd" "$RS_CHECK_COOLDOWN_SECS"; then
  : # throttled — checked within the last 30 min; skip silently
else
  record_now "$rs_check_cd" || log "WARN: cannot write $rs_check_cd"
  rs_out=$(eval "$REGISTRY_SYNC_CMD" 2>&1); rs_rc=$?
  if [ "$rs_rc" -eq 0 ]; then
    : # in sync — nothing to do
  elif [ "$rs_rc" -eq 1 ]; then
    rs_count=$(printf '%s' "$rs_out" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const i=s.indexOf("{");process.stdout.write(String(JSON.parse(i>=0?s.slice(i):s).driftCount))}catch{process.stdout.write("?")}})' 2>/dev/null)
    [ -n "$rs_count" ] || rs_count="?"
    log "registry-sync: DRIFT detected (${rs_count} drift(s)) between registry.json and live config/cron"
    rs_notify_cd="$STATE_DIR/watchdog-last-registrydrift"
    if in_cooldown "$rs_notify_cd" "$RS_NOTIFY_COOLDOWN_SECS"; then
      log "registry drift present but within notify cooldown — skipping notify"
    else
      record_now "$rs_notify_cd" || log "WARN: cannot write $rs_notify_cd"
      if [ -n "$GROUP_ID" ]; then
        log "notifying $GROUP_ID of registry drift"
        send_whatsapp "$GROUP_ID" "⚠️ registry-sync: נמצא דריפט בין registry.json לקונפיג החי (${rs_count} סטיות) — הרץ \`node shared/tools/registry-sync.mjs --check\` לפרטים ו-\`--apply\` לתיקון." || log "WARN: notify send failed"
      else
        log "WARN: no group_id — registry drift NOT notified"
      fi
    fi
  else
    log "WARN: registry-sync check failed (rc=$rs_rc) — best-effort, not notifying. head: $(printf '%s' "$rs_out" | head -c 160 | tr '\n' ' ')"
  fi
fi

exit 0
