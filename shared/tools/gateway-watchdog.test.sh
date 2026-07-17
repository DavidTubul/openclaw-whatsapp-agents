#!/usr/bin/env bash
# Tests for gateway-watchdog.sh using stub commands (no real systemd / openclaw / journal).
# Verifies the core fix: a restart happens ONLY when the live harness probe also fails.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WD="$HERE/gateway-watchdog.sh"
PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- stub openclaw: behavior controlled by env STUB_PROBE_OK / STUB_HEALTH_OK ---
cat > "$TMP/openclaw" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  agent)   if [ "${STUB_PROBE_OK:-1}" = "1" ]; then echo "OK"; exit 0
           else echo "MissingAgentHarnessError: not registered"; exit 1; fi ;;
  health)  [ "${STUB_HEALTH_OK:-1}" = "1" ] && exit 0 || exit 1 ;;
  message) echo "sent"; exit 0 ;;
  *)       exit 0 ;;
esac
EOF
chmod +x "$TMP/openclaw"

# --- stub journalctl: prints $STUB_JOURNAL ---
cat > "$TMP/journalctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${STUB_JOURNAL:-}"
EOF
chmod +x "$TMP/journalctl"

# --- notify target: injected via WATCHDOG_GROUP_ID (the watchdog resolves it from the registry in
#     production; the test override avoids needing the live registry) ---
GROUP_ID_FIXTURE="120363000000000000@g.us"

# --- healthy sentinel stubs (CHECK E passes by default; individual tests override) ---
printf '%s\n%s\n%s\n%s\n' '__serializePerConversation' 'Promise.resolve(s.sendPresenceUpdate("unavailable")).catch(() => {});' '// [inbound-hook-emit] marker' '// [inbound-hook-mention] marker' > "$TMP/monitor.js"
echo '{"agents":{"defaults":{"cliBackends":{"claude-cli":{"command":"claude"}}}}}' > "$TMP/openclaw.json"

run() {  # $1 = journal text, plus STUB_* envs already exported; echoes watchdog output
  STATE_DIR="$TMP/state" WATCHDOG_GROUP_ID="$GROUP_ID_FIXTURE" \
  OPENCLAW="$TMP/openclaw" JOURNALCTL_BIN="$TMP/journalctl" \
  LIST_AGENTS_CMD="printf 'main\nzorro\npoker\n'" \
  FAILED_UNITS_CMD="${FAILED_UNITS_CMD:-printf ''}" \
  MONITOR_JS="${MONITOR_JS:-$TMP/monitor.js}" OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$TMP/openclaw.json}" \
  REGISTRY_SYNC_CMD="${REGISTRY_SYNC_CMD:-printf in-sync; exit 0}" \
  WATCHDOG_DRYRUN=1 HEALTH_POLL_SLEEP=0 STUB_JOURNAL="$1" \
  bash "$WD" 2>&1
}

assert_contains() {  # $1 desc, $2 haystack, $3 needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "ok   - $1"; PASS=$((PASS+1));
  else echo "FAIL - $1 (missing: $3)"; echo "----"; printf '%s\n' "$2"; echo "----"; FAIL=$((FAIL+1)); fi
}
assert_absent() {  # $1 desc, $2 haystack, $3 needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "FAIL - $1 (unexpected: $3)"; FAIL=$((FAIL+1));
  else echo "ok   - $1"; PASS=$((PASS+1)); fi
}

# 1. Harness signature present BUT probe OK → NO restart (the bug we fixed).
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_PROBE_OK=1 run "May 27 [agent] MissingAgentHarnessError: not registered")
assert_contains "transient sig + healthy probe → not restarting" "$out" "NOT restarting"
assert_absent   "transient sig + healthy probe → no restart"     "$out" "would restart"

# 2. Harness signature present AND probe FAILS → restart.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_PROBE_OK=0 STUB_HEALTH_OK=1 run "May 27 [agent] MissingAgentHarnessError: not registered")
assert_contains "real dead harness → restarts" "$out" "would restart"
assert_contains "real dead harness → notifies recovery" "$out" "would send"

# 3. CHECK B was REMOVED (2026-06-27): a dropped user turn must NO LONGER produce a "resend"
#    nudge. A silently-dropped turn is now simply silent. (CHECK A/C are tested separately.)
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_HEALTH_OK=1 run $'May 27 [agent] cli exec: provider=claude-cli model=sonnet trigger=user useResume=false\nMay 27 Embedded agent failed before reply: Claude CLI failed.')
assert_absent "dropped user turn → no resend nudge (CHECK B removed)" "$out" "nudging"
assert_absent "dropped user turn → does NOT restart"                  "$out" "would restart"
assert_absent "dropped user turn → sends nothing"                     "$out" "would send"

# 5. Compaction-poisoned MAIN session → per-agent force-reset (NO restart, NO "resend" nudge).
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_HEALTH_OK=1 run 'Jun 29 [diagnostic] message processed: sessionKey=agent:main:whatsapp:group:120363000000000000@g.us outcome=error error="Error: Preflight compaction required but failed: no real conversation messages"')
assert_contains "main poison → resets MAIN in its own context" "$out" "session-hygiene --agent main --force-reset-poisoned"
assert_contains "main poison → logs the agent"                 "$out" "for agent 'main'"
assert_absent   "main poison → no restart"                     "$out" "would restart"
assert_absent   "main poison → no resend nudge (removed)"      "$out" "would send"

# 5b. REGRESSION (2026-06-29): poison from ANOTHER agent (זורו) now heals ZORRO in its OWN context —
#     it must NOT force-reset main nor apologize in Scotty's group (the old cross-agent false alarm,
#     the root cause of "סקוטי שולח 'תקלה זמנית… תשלח שוב' מדי פעם ואני לא יודע למה").
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_HEALTH_OK=1 run 'Jun 29 [diagnostic] message processed: sessionKey=agent:zorro:whatsapp:group:120363000000000000@g.us outcome=error error="Error: Preflight compaction required but failed: no real conversation messages"')
assert_contains "zorro poison → resets ZORRO"          "$out" "session-hygiene --agent zorro --force-reset-poisoned"
assert_absent   "zorro poison → does NOT reset main"   "$out" "--agent main"
assert_absent   "zorro poison → no nudge/send"         "$out" "would send"
assert_absent   "zorro poison → no restart"            "$out" "would restart"

# 5c. TWO agents poisoned in one tick → BOTH healed, each scoped to its own session.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_HEALTH_OK=1 run $'Jun 29 message processed: sessionKey=agent:main:whatsapp:group:1@g.us error="Error: Preflight compaction required but failed: no real conversation messages"\nJun 29 message processed: sessionKey=agent:zorro:whatsapp:group:2@g.us error="Error: Preflight compaction required but failed: no real conversation messages"')
assert_contains "multi poison → resets main"  "$out" "--agent main --force-reset-poisoned"
assert_contains "multi poison → resets zorro" "$out" "--agent zorro --force-reset-poisoned"

# 6. Second tick within the per-agent cooldown → that agent is NOT reset again (state kept from 5c).
out=$(STUB_HEALTH_OK=1 run 'Jun 29 message processed: sessionKey=agent:zorro:whatsapp:group:2@g.us error="Error: Preflight compaction required but failed: no real conversation messages"')
assert_contains "poison within cooldown → suppressed" "$out" "within cooldown"

# 7. Clean journal → no action at all.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(run "May 27 [whatsapp] Sent message -> ok")
assert_absent "clean journal → no restart"     "$out" "would restart"
assert_absent "clean journal → no nudge"       "$out" "nudging"
assert_absent "clean journal → no force-reset" "$out" "force-reset"
assert_absent "clean journal + healthy units/sentinels → no send" "$out" "would send"

# 8. CHECK D: failed openclaw-* units → notify (with 6h cooldown).
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(FAILED_UNITS_CMD="printf 'openclaw-reflect.service\n'" run "May 27 [whatsapp] ok")
assert_contains "failed unit → detected"  "$out" "FAILED openclaw units detected: openclaw-reflect.service"
assert_contains "failed unit → notifies"  "$out" "would send"
out=$(FAILED_UNITS_CMD="printf 'openclaw-reflect.service\n'" run "May 27 [whatsapp] ok")
assert_contains "failed unit again within cooldown → suppressed" "$out" "within cooldown — skipping notify"

# 9. CHECK E: a reverted vendored patch → notify (24h cooldown); healthy markers → silent.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
echo 'stock file without markers' > "$TMP/monitor-stock.js"
out=$(MONITOR_JS="$TMP/monitor-stock.js" run "May 27 [whatsapp] ok")
assert_contains "wiped monitor patches → sentinel fires" "$out" "vendored-patch sentinel FAILED"
assert_contains "wiped monitor patches → names all four" "$out" "per-conversation-serialization ghost-mode inbound-hook-emit inbound-hook-mention"
assert_contains "wiped monitor patches → notifies"       "$out" "would send"
out=$(MONITOR_JS="$TMP/monitor-stock.js" run "May 27 [whatsapp] ok")
assert_contains "sentinel within cooldown → suppressed"  "$out" "within cooldown — skipping notify"

# 9b. Config missing the cliBackends harness fix → sentinel fires on config too.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
echo '{"agents":{"defaults":{}}}' > "$TMP/openclaw-bare.json"
out=$(OPENCLAW_CONFIG="$TMP/openclaw-bare.json" run "May 27 [whatsapp] ok")
assert_contains "missing cliBackends → sentinel fires" "$out" "cliBackends-config"

# 10. CHECK F: registry-sync reports IN-SYNC (exit 0) → no drift log, no notify.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(REGISTRY_SYNC_CMD="printf '{\"ok\":true,\"driftCount\":0}'; exit 0" run "May 27 [whatsapp] ok")
assert_absent "registry in-sync → no drift log" "$out" "DRIFT detected"
assert_absent "registry in-sync → no notify"    "$out" "would send"

# 11. CHECK F: registry-sync reports DRIFT (exit 1) → logs count + notifies once.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(REGISTRY_SYNC_CMD="printf '{\"ok\":false,\"driftCount\":3}'; exit 1" run "May 27 [whatsapp] ok")
assert_contains "registry drift → logs the count"  "$out" "DRIFT detected (3 drift(s))"
assert_contains "registry drift → notifies owner"  "$out" "would send"
assert_contains "registry drift → Hebrew message with N" "$out" "(3 סטיות)"

# 11b. Second tick within the 30-min run-cooldown (state kept from 11) → check skipped, NO duplicate.
out=$(REGISTRY_SYNC_CMD="printf '{\"ok\":false,\"driftCount\":3}'; exit 1" run "May 27 [whatsapp] ok")
assert_absent "registry drift within run-cooldown → check throttled, no re-check" "$out" "DRIFT detected"
assert_absent "registry drift within run-cooldown → no duplicate notify"          "$out" "would send"

# 11c. Run-cooldown expired but notify-cooldown still active (drop only the check-cooldown file):
#      the check runs again and STILL logs the drift, but does NOT re-notify (notify at most once / 6h).
rm -f "$TMP/state/watchdog-last-registrycheck"
out=$(REGISTRY_SYNC_CMD="printf '{\"ok\":false,\"driftCount\":3}'; exit 1" run "May 27 [whatsapp] ok")
assert_contains "drift persists → still logged every throttled-in run" "$out" "DRIFT detected (3 drift(s))"
assert_contains "drift persists within notify-cooldown → notify suppressed" "$out" "within notify cooldown — skipping notify"
assert_absent   "drift persists within notify-cooldown → no duplicate send" "$out" "would send"

# 12. CHECK F: registry-sync tool FAILURE (non-0/1 exit) → WARN only, no notify, run still exits 0.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(REGISTRY_SYNC_CMD="printf 'boom: cannot find module'; exit 2" run "May 27 [whatsapp] ok"); frc=$?
assert_contains "registry-sync failure → WARN logged" "$out" "registry-sync check failed (rc=2)"
assert_absent   "registry-sync failure → no notify"   "$out" "would send"
assert_absent   "registry-sync failure → no false drift log" "$out" "DRIFT detected"
if [ "$frc" -eq 0 ]; then echo "ok   - registry-sync failure → watchdog run still exits 0"; PASS=$((PASS+1));
else echo "FAIL - registry-sync failure → watchdog exited $frc"; FAIL=$((FAIL+1)); fi

echo ""
echo "# pass $PASS  fail $FAIL"
[ "$FAIL" -eq 0 ]
