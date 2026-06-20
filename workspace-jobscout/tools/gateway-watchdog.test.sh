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

# --- config with a group_id ---
echo '{"whatsapp":{"group_id":"120363000000000000@g.us"}}' > "$TMP/config.json"

run() {  # $1 = journal text, plus STUB_* envs already exported; echoes watchdog output
  STATE_DIR="$TMP/state" CONFIG="$TMP/config.json" \
  OPENCLAW="$TMP/openclaw" JOURNALCTL_BIN="$TMP/journalctl" \
  WATCHDOG_DRYRUN=1 HEALTH_POLL_SLEEP=0 STUB_JOURNAL="$1" \
  bash "$WD" 2>&1
}

assert_contains() {  # $1 desc, $2 haystack, $3 needle
  if printf '%s' "$2" | grep -qF "$3"; then echo "ok   - $1"; PASS=$((PASS+1));
  else echo "FAIL - $1 (missing: $3)"; echo "----"; printf '%s\n' "$2"; echo "----"; FAIL=$((FAIL+1)); fi
}
assert_absent() {  # $1 desc, $2 haystack, $3 needle
  if printf '%s' "$2" | grep -qF "$3"; then echo "FAIL - $1 (unexpected: $3)"; FAIL=$((FAIL+1));
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

# 3. No harness sig, but a dropped-turn sig + healthy gateway → nudge to resend.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_HEALTH_OK=1 run "May 27 Embedded agent failed before reply: Claude CLI failed.")
assert_contains "dropped turn → nudges user"   "$out" "nudging"
assert_absent   "dropped turn → does NOT restart" "$out" "would restart"

# 4. Dropped-turn sig but within cooldown → no second nudge.
out=$(STUB_HEALTH_OK=1 run "May 27 claude live session turn failed: error=FailoverError")
assert_contains "dropped turn within cooldown → suppressed" "$out" "dead-turn cooldown"

# 5. Compaction-poisoned session → force-reset (NO restart) + nudge.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(STUB_HEALTH_OK=1 run 'Jun 07 [diagnostic] outcome=error error="Error: Preflight compaction required but failed: no real conversation messages"')
assert_contains "compaction poison → force-resets session" "$out" "session-hygiene --force-reset"
assert_contains "compaction poison → nudges user"          "$out" "would send"
assert_absent   "compaction poison → does NOT restart"     "$out" "would restart"

# 6. Compaction poison within cooldown → no second reset.
out=$(STUB_HEALTH_OK=1 run 'Jun 07 error="Error: Preflight compaction required but failed: no real conversation messages"')
assert_contains "compaction poison within cooldown → suppressed" "$out" "within cooldown"

# 7. Clean journal → no action at all.
rm -rf "$TMP/state"; mkdir -p "$TMP/state"
out=$(run "May 27 [whatsapp] Sent message -> ok")
assert_absent "clean journal → no restart"     "$out" "would restart"
assert_absent "clean journal → no nudge"       "$out" "nudging"
assert_absent "clean journal → no force-reset" "$out" "force-reset"

echo ""
echo "# pass $PASS  fail $FAIL"
[ "$FAIL" -eq 0 ]
