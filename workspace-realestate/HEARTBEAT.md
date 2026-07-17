# Keep this file empty (or comments-only) to skip heartbeat API calls.
#
# Add tasks below as normal (non-comment) lines when you want the agent to
# check something periodically. While only comment lines are present, OpenClaw
# skips the heartbeat turn entirely.
#
# דיגיט is conversational-only (no cron, no periodic task), so it needs no
# heartbeat. Keep this comments-only so the heartbeat stays OFF.
#
# History: this file previously held stray template content (a ```markdown
# fence + a "## Related" doc link), which counted as a real task and would keep
# the heartbeat ON (resuming a stale session → instant failure every 30 min).
# Cleaned to comments-only 2026-06-22, matching workspace-jobscout/HEARTBEAT.md.
