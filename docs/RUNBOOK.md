# OpenClaw / Scotty — Operations & Runbook

> Split out of CLAUDE.md on 2026-06-08 to keep the always-loaded project map lean.
> This is **diagnostic / runbook** material — read it when operating or debugging the bot
> (silent bot, no-reply, missing phone push, compaction errors, session resets, model/cron changes).
> CLAUDE.md links here; it is NOT auto-loaded, so it costs no tokens on a normal session.

## Acknowledgment hook (ack-react) — verified 2026-05-27
Every inbound WhatsApp message in the Job Scout group gets an automatic 👍 via a gateway
hook (`workspace-jobscout/tools/hooks/ack-react/`, event `message:received`), independent of the
LLM — this replaced the unreliable LLM-driven 👀/✅ indicator. Registered via
`hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` (handler lives in workspace,
so it survives `openclaw` upgrades; if `openclaw hooks list` ever stops showing `ack-react`,
re-add the extraDirs entry and restart). Verify: `openclaw hooks list` shows `ack-react ✓ ready`;
send a group message → journal shows `Sent reaction "👍" -> message <id>`.

## Session hygiene — keeps the conversational session small (added 2026-05-30)
The WhatsApp group session is kept small so OpenClaw's (broken) native compactor never runs —
the real fix for the silent-bot/hallucination failure (supersedes the manual "reset oversized
session" runbook below). Mechanism (`workspace-jobscout/tools/session-hygiene.mjs`, run every 5 min by the
`openclaw-session-hygiene.timer` user unit):
- **Metric:** byte size of the active group transcript `.jsonl` (NOT `contextTokens` — that field is
  the constant 1,048,576 = window size, identical on every session, NOT a fullness gauge; verified).
  Reset threshold default 1,000,000 bytes (`session_hygiene` block in `workspace-jobscout/.config/job-scout.json`).
- **Triggers:** size ≥ threshold (any time) OR a daily ≈**07:30 Asia/Jerusalem** window (computed via
  `Intl` tz conversion, so correct even though the server is UTC) — both **idle-gated** (transcript
  mtime older than `idle_secs`, default 90s) so a reset never interrupts a live chat. Daily reset
  de-duped via `workspace-jobscout/data/session-hygiene-last-daily`.
- **Reset primitive (restart-free, verified by spike + e2e 2026-05-30):** back up `sessions.json` →
  `mv <id>.jsonl <id>.jsonl.archived-*` → `openclaw sessions cleanup --fix-missing --enforce`; the
  next inbound message auto-creates a fresh session. **NO gateway restart** (restarts risk the
  harness-deregistration failure documented below). Aborts safely if archive/cleanup fails (session
  left intact — never produces the missing-file-but-entry-kept state that broke it on 2026-05-28).
  Note `--fix-missing --enforce` also prunes any other stale missing-transcript entries (harmless).
- **Continuity:** the `chat-log` gateway hook (`workspace-jobscout/tools/hooks/chat-log/`, events
  `message:received`+`message:sent`) mirrors every group message to an append-only record
  (`workspace-jobscout/data/chat-log/<group>.jsonl`, full text, never trimmed) and regenerates
  `workspace-jobscout/RECENT_CHAT.md`, injected via `prompt-qa.md` ("Recent context — read FIRST").
  Job data lives in the Sheet, untouched by resets.
  **Noise-collapse (2026-06-07 — fixed David's "loses conversation context" complaint):** the
  window is `recent_window` **conversational turns** (now **60**, was 30) — NOT raw records.
  `formatRecentMd` `classify()`-es each record (chat / scout-report / reset-notice / internal-log)
  and **collapses consecutive non-chat runs into a single dated marker** (`— [07/06 · סריקה
  יומית · דוח נשלח] —`), so a week of daily scout reports + internal logs no longer evicts real
  back-and-forth from the window. Before this, ~4 noise records/day filled the 30-slot window in
  ~1 week and the prior evening's conversation was gone after the 07:30 reset. Scotty replies
  still capped at 600 chars; raw log untouched (render-layer only). Unit-tested in
  `chat-log/handler.test.mjs` (`classify` + collapse). Tunable: `session_hygiene.recent_window`.
- **Notify:** a short Hebrew message to the group on each reset (toggle `notify_on_reset`).
Verify: `node workspace-jobscout/tools/session-hygiene.mjs --dry-run` (expect `→ noop` today);
`systemctl --user list-timers openclaw-session-hygiene.timer`; `openclaw hooks list` shows
`chat-log ✓ ready`. Tunables live in the `session_hygiene` config block.

## Phone push notifications suppressed by the bot — "ghost mode" fix (applied 2026-05-30, VERIFIED WORKING)
**Symptom:** while the bot is connected, David gets **no WhatsApp push on his phone in ANY chat**; unlinking restores them.
**Cause:** Scotty is a Baileys **companion device on David's OWN number** (`selfChatMode:true`); WhatsApp routes notifications to the "active" linked device (known Baileys behavior, openclaw issue #30286; fix = presence `unavailable`). On-connect fix was already correct; the leak was the bot flipping back `online` via typing indicator (`composing`), 👍 reactions, and read receipts, never returning to `unavailable`.
**Fix (two parts):**
  1. **Config (survives upgrades):** `channels.whatsapp.accounts.default.sendReadReceipts:false` in `~/.openclaw/openclaw.json`.
  2. **Vendored patch ⚠️ NON-STOCK (an `npm i -g openclaw`/`openclaw update` overwrites it — re-apply):** in `…/extensions/whatsapp/dist/monitor-ClhD-fQ6.js`, inside `attachWebInboxToSocket`, when `selfChatMode`: (a) a 15s interval re-asserts `sendPresenceUpdate("unavailable")` (cleared on `onClose`); (b) `sendComposing` early-returns. Both guarded by `if (options.selfChatMode)`. Backups: `monitor-ClhD-fQ6.js.bak-ghostmode-*`, `openclaw.json.bak-ghostmode-*`.
**Verify:** re-link (`./openclaw channels login --channel whatsapp`), then with the bot connected send yourself a message from another phone → phone should still get a push. If still suppressed, the single-number approach is exhausted → move Scotty to a **separate number** (clean permanent fix). Single-number ghost mode verified sufficient 2026-05-30; no separate number needed.

## Chat reliability — "the chat crashes on my messages" (root-caused 2026-05-27)
**NOT a process crash** (`NRestarts`=0, `Result=success`). The gateway drops a turn only when **restarted mid-reply**: `systemctl restart` SIGTERMs the in-flight `claude -p` child (`KillMode=control-group`) → `Embedded agent failed before reply` → `FailoverError` → silence (`retry/fallback/failover=null`, no drain on SIGTERM). Every dropped reply correlated 1:1 with a SIGTERM; zero were model flakiness. Restart spikes came from the (fixed) `MissingAgentHarnessError` storm + dev sessions restarting while David chatted.
**OPERATIONAL RULE:** do NOT restart the gateway to apply `skills/`/prompt edits — they hot-reload (CLI session auto-resets on `reason=system-prompt`); restarting only drops the in-flight message. Avoid restarting while David is chatting; if you must, check the journal is idle first.
**Hardening 2026-05-27** (`workspace-jobscout/tools/gateway-watchdog.sh`, tests `gateway-watchdog.test.sh`): watchdog now (1) **probes the harness live before restarting** (a transient `MissingAgentHarnessError` no longer triggers a turn-killing restart); (2) **nudges David to resend** ("ההודעה נפלה… תשלח שוב 🙏") on a dropped turn. Cooldown-gated; CHECK B skipped if CHECK A restarted.

## Known failure mode: live `channels.whatsapp.*` config edit flaps the WhatsApp connection → likes/replies silently undelivered (root-caused 2026-06-08)
**Symptom:** after editing `~/.openclaw/openclaw.json` under `channels.whatsapp.*`, David reports "Scotty isn't answering" and "not even a 👍 was sent" — yet the journal shows inbound arriving, ack-react firing, and the agent turn even producing a reply.
**Root cause:** the gateway's config-watcher hot-reloads the change (`[reload] config change detected … channels.whatsapp.accounts.default.replyToMode`) by **restarting the WhatsApp provider**. The reconnect doesn't come up clean — the WhatsApp Web socket flaps with `status 408 (Connection was lost)` for several minutes (seen 11:14–11:18), and the event loop blocks (`liveness warning eventLoopDelayP99Ms≈15000`). **Outbound during those windows — both the 👍 ack and the agent's reply — is dropped at the socket**, even though everything upstream (inbound, ack decision, agent turn) ran. So the config edit itself was valid (it was promoted to `openclaw.json.last-good`); the damage is purely the reconnect churn.
**Fix:** one **clean `systemctl --user restart openclaw-gateway.service`** (when chat is idle) → a single fresh provider start that settles to `Listening for WhatsApp inbound messages` (≈90–130s incl. plugin load; a one-off `status 428` during setup is normal). Verify with `journalctl --user -u openclaw-gateway.service --since <t> | grep -iE "Listening|408|logged out|qr"` — no further drops = stable. Creds persist, so **no QR re-pair**.
**OPERATIONAL RULE:** when you change any `channels.whatsapp.*` key, do the clean restart **immediately after the edit** (chat idle) — do NOT rely on the live hot-reload, which leaves the connection flapping for minutes. (This is the opposite of the prompt/skill rule above: those DO hot-reload safely; channel-config changes do not.)
**Reference:** `replyToMode: "all"` (WhatsApp-style threaded quote-replies) was added to `channels.whatsapp.accounts.default` this way on 2026-06-08; the outage was the reconnect churn, not the setting. Documented in `CLAUDE.md` → "WhatsApp threaded replies".

## Health check (verified 2026-05-26 ~22:33)
- ✅ Sheet webhook alive (`node tools/sheet.mjs ping` → ok)
- ✅ OpenClaw gateway running on port 18789 (systemd user service `openclaw-gateway.service`, `Restart=always`)
- Last scout run (19:10): 42 candidates → 7 kept → 7 sent
- If "the bot didn't answer a WhatsApp prompt": first run `./openclaw channels logs | tail` and look for `MissingAgentHarnessError` (see failure mode below). Else check the WhatsApp channel/session connection — infra (sheet/tools) is usually healthy.

## Known failure mode: user-scope Claude Code plugins/hooks leak into Scotty (stall) — fixed 2026-05-31
**Symptom:** David sends Scotty a normal WhatsApp message; the 👍 ack lands but no reply comes for
minutes. Journal shows `stalled session ... activeWorkKind=embedded_run lastProgress=embedded_run:started
recovery=none` repeating (147s, 177s, 207s…). Eventually may recover or drop.
**Cause:** Scotty runs every turn as `claude -p --setting-sources user --allowedTools mcp__openclaw__*`
on **David's own user account**, so it inherits **everything in `~/.claude/settings.json`** — including
enabled plugins and their SessionStart hooks. On 2026-05-31 the **`superpowers` plugin** (enabled at user
scope) injected its giant `<EXTREMELY_IMPORTANT>` SessionStart block ("you MUST invoke the `Skill` tool
before ANY response"). But `--allowedTools mcp__openclaw__*` makes the `Skill` tool **unavailable** →
the agent is ordered to call a tool it can't → deadlock/stall. The injection also bloats context and
derails Scotty's persona even when it doesn't fully stall.
**Fix applied + verified 2026-05-31:** set `enabledPlugins."superpowers@claude-plugins-official": false`
in `~/.claude/settings.json` (backup `~/.claude/settings.json.bak-superpowers-*`). Verified a fresh
`claude -p --setting-sources user` no longer carries the injection. `context7` left enabled (MCP-only,
excluded from Scotty by `--strict-mcp-config`). Each Scotty turn is a fresh process, so the fix takes
effect on the next inbound message — no gateway restart.
**General rule:** the production bot and David's interactive dev Claude Code **share one user account +
`~/.claude`**. Any user-scope plugin or SessionStart/user hook David enables will run inside Scotty's
restricted-tool sessions. Enable dev-only tooling at **project scope** (Scotty uses only
`--setting-sources user`, never project/local); keep user scope minimal. Verify after enabling anything:
`claude -p --setting-sources user "do you see superpowers/EXTREMELY_IMPORTANT in your context?"` → expect No.

## Known failure mode: agent harness de-registers (the bot goes silent)
**Symptom:** WhatsApp linked + gateway alive, but every inbound fails at dispatch with `MissingAgentHarnessError: Requested agent harness "claude-cli" is not registered.` NO reply, NO error; systemd doesn't catch it (process never exits).
**Cause (openclaw 2026.5.22):** `claude-cli` is a **CLI runtime/backend** (`runCliAgent` → `claude -p` OAuth), **not** a plugin harness — intentionally never in the harness registry (`pluginHarnesses=[]` is normal). The per-message delivery-defaults resolver (`dispatch-cQjCJvZr.js` → `selectAgentHarness` → `selectAgentHarnessDecision` in `selection-*.js`) **lacks the `isCliAgentRuntime` early-return guard** its model-fallback sibling has, so for a forced `agentRuntime.id:"claude-cli"` it throws and aborts the inbound msg before execution. **Restart does NOT fix this** (deterministic throw once the registry degrades).
**FIX APPLIED + VERIFIED 2026-05-27 (two parts):**
  1. **Config (survives upgrades):** added `agents.defaults.cliBackends:{"claude-cli":{"command":"claude"}}` to `~/.openclaw/openclaw.json` → `isCliProvider("claude-cli")` true (config path, no registry dependency) → routes to the CLI runner. The `models auth login --method cli` run (compaction section below) also added `agents.defaults.agentRuntime:{id:"claude-cli"}` + auth profile.
  2. **Vendored patch ⚠️ NON-STOCK (an `npm i -g openclaw` overwrites it — re-apply if the silent-bot returns):** in `…/openclaw/dist/selection-hR-AeOeU.js`, inside `selectAgentHarnessDecision`, before `throw new MissingAgentHarnessError(runtime)`, guard: if runtime is a CLI alias (`*-cli`) return the pi-harness decision instead of throwing (delivery-defaults only; execution still routes to `runCliAgent`).
Verify: `./openclaw agent --session-key diagnostic:harness-check -m "ping"` returns a reply; WhatsApp test → `journalctl … | grep "claude live session turn"` with no `MissingAgentHarnessError`/`No API key`.
**Mitigation (insufficient alone):** `gateway-watchdog.sh` (60s via `openclaw-watchdog.timer`) scans for `MissingAgentHarnessError` → restarts + notifies David (10-min cooldown). Restart alone no longer clears it — the config + selection-guard fixes do. Manage: `systemctl --user list-timers openclaw-watchdog.timer`, `journalctl --user -u openclaw-watchdog.service`.

## Known failure mode: compaction fails on long sessions → "Missing API key for provider anthropic"
**Symptom:** WhatsApp reply is the literal `Missing API key for provider "anthropic". Configure the gateway auth…`.
**Cause (verified 2026-05-26):** normal turns run via `provider=claude-cli` (OAuth) fine, but **context compaction** is a separate `[agent/embedded]` subsystem calling the raw `anthropic` SDK provider (**API key, not OAuth**; can't use a CLI backend). With **no anthropic auth profile** it dies `No API key found for provider anthropic`. Only triggers once a session grows large (culprit: Job Scout group at ~1.1M cumulative tokens). Diagnose: `journalctl … | grep compaction-diag` → `outcome=failed detail=No_API_key_found_for_provider_anthropic`.
**Immediate fix:** reset the oversized session — stop gateway, archive its `<sessionId>.jsonl`, remove its entry from `~/.openclaw/agents/main/sessions/sessions.json` (backup first), restart. Fresh session won't compact. Loses that chat's history (real state is in Sheet + `workspace-jobscout/data`, acceptable).
**Permanent fix APPLIED + VERIFIED 2026-05-27 (subscription-only, no API key):** ran `openclaw models auth login --provider anthropic --method cli` → auth profile `anthropic:claude-cli [claude-cli/oauth]`, so the embedded provider authenticates via the CLI's subscription OAuth. The profile refreshes from `~/.claude/.credentials.json`; if compaction errors return, re-run the login. Check: `openclaw models auth list` must show `anthropic:claude-cli`.

## Known failure mode: "Scotty likes my message but doesn't reply" — compaction-poisoned session (root-caused + auto-recovery 2026-06-07/08)
**Symptom:** 👍 ack lands but **no reply ever comes**, recurring every message until reset. (David: "עושה לייק אבל לא מגיב.")
**Cause (NOT a stall / MissingAgentHarness / API-key bug):** turn aborts at dispatch with `error="Preflight compaction required but failed: no real conversation messages"`. The transcript accumulated **only `role:assistant`** messages (morning cron-scout writes 3–4 assistant msgs — David + guest reports + a leaked English recap — plus the hygiene reset notice). When a big turn inflates context enough to require preflight compaction, the compactor needs real user/assistant *pairs*; assistant-only → `[compaction] skipping` → preflight treats "required but skipped" as a hard failure → throws before the LLM runs. **Escapes session-hygiene:** hygiene resets on byte size (≥1 MB) but the poisoned transcript is tiny (~5.5 KB).
**Immediate fix (manual, restart-free):** reset primitive — back up `sessions.json` → `mv <id>.jsonl <id>.jsonl.archived-*` → `openclaw sessions cleanup --fix-missing --enforce`; next inbound auto-creates a fresh session. Verify: `grep -c "<group>@g.us" ~/.openclaw/agents/main/sessions/sessions.json` → 0.
**Auto-heal APPLIED + TESTED 2026-06-07, idle-gate gap fixed 2026-06-08:** `session-hygiene.mjs` gained `--force-reset` (idle-gated) and then `--force-reset-poisoned` + pure `decideForce()`/`isPoisoned(transcript)` (assistant turns present, **0 user turns** = poisoned). `gateway-watchdog.sh` **CHECK C** scans the journal (90s window) for `Preflight compaction required but failed` → runs `--force-reset-poisoned` (restart-free; per-session not per-process) + nudges David to resend (cooldown `watchdog-last-compactreset`, 10 min). Why poisoned bypasses the idle-gate: the Job Scout group is busy (every inbound + 👍 ack touches the transcript → never idle), so the original idle-gated force-reset **deferred forever** while David stayed stuck (verified 2026-06-08). A confirmed-poisoned session is already broken with no live conversation to interrupt → reset immediately; if NOT poisoned, fall back to idle-gating (a healthy-but-busy chat is never killed).
Verify: `bash workspace-jobscout/tools/gateway-watchdog.test.sh` (14 pass); `node --test workspace-jobscout/tools/session-hygiene.test.mjs` (21 pass); `--force-reset-poisoned` no-ops on a clean session; `systemctl --user is-active openclaw-watchdog.timer` → active.

**PROACTIVE self-heal — ROOT-CAUSE fix for the recurring/daily case (2026-06-08, David: "זה קורה לי הרבה לאחרונה"):** the auto-heal above is *reactive* — it fires only AFTER David hits the error (👍-no-reply, then a resend nudge). Forensics on the archived transcripts pinned WHY it recurs daily: the **08:00 cron scout delivers its per-person reports into the group's CONVERSATIONAL session as assistant turns** (confirmed: `…archived-20260608-093057` = `user=0 assistant=5` — David+guest+the guest reports + the silent `.` + the nudge). The session is **poisoned every morning**, and the 07:30 daily reset runs *before* the scout so it never helps. Adding **the guest** (3 enabled people now) made the morning poison heavier/more reliable → "happens a lot lately". **Fix:** `session-hygiene.mjs` now checks `isPoisoned()` on **every regular timer run** (not only under `--force-*`) and, if the live session is assistant-only, resets it **proactively and SILENTLY** (`decideProactivePoison()`, idle-gate bypassed) — clearing the scout residue *before* David's first message, so he never hits the error. SILENT is essential: a "started a new conversation" notify would itself create a fresh assistant-only session and re-poison (infinite reset↔notify loop). The reactive CHECK C + nudge stays as the backstop for the sub-timer-interval window (and for the *mid-day* variant: a single huge inline turn — e.g. an ad-hoc deep scan — inflates context past the compaction threshold; mitigate by running heavy work via a tool that returns compact JSON, not inline). Verify: `node --test workspace-jobscout/tools/session-hygiene.test.mjs` (21 pass, incl. `decideProactivePoison`). Note: `tools/self-edit.mjs verify` now runs ALL tools + lib tests (80).

## Known failure mode: "an agent crashed and took the others down" — actually a full-HOST reboot (root-caused 2026-06-15)
**Symptom (David: "הסוכן דאוס קרס... זה גם השפיע על הסוכנים האחרים שהפסיקו לעבוד"):** one agent (here: דאוס/poker) suddenly stops responding mid-chat AND so do all the others, at the same moment.
**Cause:** NOT an agent/OpenClaw bug. **The whole machine rebooted.** All 4 agents (סקוטי/main, דיגיט/digit, דאוס/poker, פיצי/pitzi) run behind ONE shared gateway on ONE host, so a host reboot drops all of them together for the ~6–7 min the gateway takes to come back. This host is **multi-tenant** — another user (`<other-tenant>`, has sudo) can reboot it. Confirmed instance: `Jun 15 22:35 UTC` (= 01:35 Asia/Jerusalem) the admin ran, via sudo, `systemd-run --on-active=2s --unit=claude-reboot systemctl reboot` (David confirmed: done to bring up a VPN). Graceful shutdown (`Stopping openclaw-gateway.service` → SIGTERM in the journal), not a crash/panic. **Out of our control** (no root; another tenant owns the box).
**Diagnose:** `last reboot` (was there a boot boundary?); `sudo journalctl --since … | grep -iE 'reboot|will reboot now|claude-reboot'` to see WHO/WHY; user journal `journalctl --user -b -1 -n 80` tail shows a graceful `SIGTERM received` (planned) vs an abrupt cut (crash/power-loss). The `qxl/[TTM] Buffer eviction failed` kernel lines are virtual-GPU VRAM noise, unrelated.
**Recovery is already automatic (verified):** gateway service is `enabled` + `WantedBy=default.target`, user `Linger=yes` (starts at boot with no login), `Restart=always RestartSec=5`. So every reboot self-heals — agents came back on their own; no fix needed in our stack.
**Reduce confusion (APPLIED 2026-06-15):** `workspace-jobscout/tools/boot-notify.mjs` + `~/.config/systemd/user/openclaw-boot-notify.service` (oneshot, `After=openclaw-gateway`, `WantedBy=default.target` → fires once per real boot, NOT on a gateway restart). It waits (retries ~20 min) for the gateway+WhatsApp to be ready, then posts ONE Hebrew message to the Job Scout group: "🔄 המערכת עלתה מחדש אחרי reboot… כל הסוכנים פעילים ✅", incl. boot time (Asia/Jerusalem) and a graceful-vs-abrupt shutdown heuristic (from `journalctl --user -b -1`). So a host reboot is never again mistaken for an agent crash. Idempotent per boot (keyed on `/proc/stat` btime → `~/.openclaw/boot-notify.state`; `/tmp` is NOT tmpfs here so we don't rely on it being wiped). Test without a reboot: `node tools/boot-notify.mjs --dry-run` (prints, sends nothing); live one-off: `systemctl --user start openclaw-boot-notify.service`. Hard rule #1 preserved — only ever targets the Job Scout group.
