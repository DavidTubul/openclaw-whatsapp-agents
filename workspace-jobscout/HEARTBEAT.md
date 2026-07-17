# Keep this file empty (or comments-only) to skip heartbeat API calls.
#
# Add tasks below as normal (non-comment) lines when you want the agent to
# check something periodically. While only comment lines are present, OpenClaw
# skips the heartbeat turn entirely.
#
# Scotty has NO periodic heartbeat task: its scheduled work runs from the 08:00
# cron (daily scout) and the session-hygiene timer — not the heartbeat. Keep
# this comments-only so the 30-min heartbeat stays OFF.
#
# History: this file previously held stray template content (a ```markdown
# fence + a "## Related" doc link), which counted as a real task and kept the
# heartbeat ON. Every 30 min it tried to RESUME a stale, un-resumable session
# (auth-epoch mismatch) and failed instantly ("FailoverError / Claude CLI
# failed."). Those failures occasionally tripped the gateway watchdog's CHECK B
# into a false "your message dropped, resend it 🙏" nudge to David. Disabled
# 2026-06-22.
