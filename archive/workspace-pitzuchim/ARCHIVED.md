# ARCHIVED — פיצי / Pitzi (nuts-shop customer-service demo bot)

**Archived 2026-07-17.** This was the חנות הפיצוחים nuts-shop customer-service bot (FAQ +
freshness-complaint workflow). It has been **retired**: its runtime wiring is removed and it no
longer answers in any WhatsApp group. The code and data are kept here intact for a future revival.

What "archived" means in practice:
- `shared/registry.json` marks the `pitzi` agent **and** the `pitzi-demo` group `archived: true`, so
  the loader hides both from `listAgents()` / `getAgent()` / `getGroups()` / the byGroup index, and
  `registry-sync` removes pitzi's allowlist entry, binding, and `agents.list` row from `openclaw.json`.
- The workspace runs **in place from here**: the agent's `workspaceDir` / `configPath` in
  `shared/registry.json` already point at `archive/workspace-pitzuchim/...`, and the
  `openclaw-session-hygiene-pitzi.service` systemd unit's `ExecStart` already points at
  `archive/workspace-pitzuchim/tools/session-hygiene.mjs`. Its `openclaw-session-hygiene-pitzi.timer`
  is expected to be **disabled** while archived.
- The tool files' relative imports were re-depthed to `../../../shared/…` to match this archive
  location (one level deeper than `workspace-*/tools/`), so `node --check` passes and the shims
  resolve the shared libs here. (If the workspace is ever moved back to the repo root — see the note
  under "How to revive" — that depth must revert to `../../shared/…`.)

## How to revive (in place — no `git mv` needed)
1. In `shared/registry.json`: set `archived: false` on the `pitzi` agent entry and the `pitzi-demo`
   group entry. (`workspaceDir`/`configPath` already point here, so nothing else in the registry moves.)
2. Re-derive the gateway config: `node shared/tools/registry-sync.mjs --check` (review the drift),
   then `--apply`.
3. Re-enable the session-hygiene timer (its `ExecStart` already targets this archive path):
   `systemctl --user enable --now openclaw-session-hygiene-pitzi.timer`.
4. Restart the gateway while chat is idle: `openclaw gateway restart`.

> Prefer reviving in place (above). If you instead want the workspace back at the repo root, that is a
> larger change: `git mv archive/workspace-pitzuchim workspace-pitzuchim`, revert each tool file's
> imports from `../../../shared/…` back to `../../shared/…`, restore the registry `workspaceDir`/
> `configPath` and the systemd `ExecStart` to `workspace-pitzuchim/...`, then run `registry-sync --apply`
> and restart.
