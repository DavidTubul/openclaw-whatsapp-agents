# OpenClaw / Scotty — Operations & Runbook

> Split out of CLAUDE.md on 2026-06-08 to keep the always-loaded project map lean.
> This is **diagnostic / runbook** material — read it when operating or debugging the bot
> (silent bot, no-reply, missing phone push, compaction errors, session resets, model/cron changes).
> CLAUDE.md links here; it is NOT auto-loaded, so it costs no tokens on a normal session.

## Finding a new group's `group_id` (the simple, canonical way) — documented 2026-06-26

Wiring a new agent needs the WhatsApp group's id (`120363…@g.us`). It is **simple** — there is one
gotcha that makes it *look* complex if you hit it.

**The method (works every time):**
1. **Add the bot's own WhatsApp number to the group.** The gateway is connected as **one** account —
   currently **<BOT_PHONE>** (confirm anytime: `openclaw directory self --channel whatsapp`). If that
   number is **not a member** of the group, the bot receives **nothing** and you'll see no log line.
2. Send any message in the group.
3. Read the id straight from the gateway log:
   ```bash
   journalctl --user -u openclaw-gateway.service --since "-5 min" | grep -E '120363[0-9]{10}@g\.us'
   # → [whatsapp] Inbound message <THE_ID>@g.us -> <BOT_PHONE> (group, N chars)
   ```
   That `<…>@g.us` is the `group_id`. No config change, no restart needed to discover it.

**Why this always works:** the `Inbound message <jid>` log line is emitted at receipt **before** the
allowlist/`groupPolicy` filter (verified in `monitor-*.js`: the log precedes the `groupPolicy` check).
So a message from **any** group — allowlisted or not — shows its id in the log, *as long as the bot
number is in the group*.

**The gotcha (this is the whole "complexity"):** if the bot number is **not** a member, the message
never reaches the gateway → **zero** inbound lines, and a live `journalctl -f` capture stays empty.
That looks like a deep problem but it isn't — it just means **add <BOT_PHONE> to the group and
resend.** (Diagnosed 2026-06-26 wiring זורו: David's test messages to "חאלס לעשן" produced no inbound
lines at all → the bot number wasn't in that group.)

**Can you read the id from the WhatsApp app yourself?** No — WhatsApp's UI never shows the `@g.us`
jid. The gateway-log method above is the project standard. (WhatsApp Web + browser devtools can show
it, but it's fiddlier than just reading the log.)

> ❌ Do **not** temporarily flip `groupPolicy` to `open` to "discover" an id — it loosens access for
> all agents, needs a restart, and **won't even help** if the real cause is non-membership (no message
> is arriving to filter). Fix membership first.

## Registry & registry-sync — the single source of WhatsApp wiring (registry v2, 2026-07-17)

`shared/registry.json` (registry v2) is the **single source of truth for all WhatsApp wiring**, not just
personas. It owns: the top-level `groups` map (symbolic name → `{jid, label, requireMention, listenOnly?,
routeAgentId?, systemPrompt?}`), `owner {e164,label}` (once, top-level), and per-agent `identity
{name,emoji,mentionPatterns?}`, symbolic `primaryGroup`/`groups`, `listenGroups`, `cronTargets`
(per-cron-job symbolic target, `default`→primary), plus optional `sessionHygiene`/`selfEdit`/`chatLog`/
`ackReact` blocks. The live `~/.openclaw/openclaw.json` (whatsapp allowlist + `bindings` + `agents.list`
identity/mentionPatterns/workspace) **and** each cron's `delivery.to` are **DERIVED** from it — do NOT
hand-edit openclaw.json. Every wiring reader goes through `shared/lib/agent-registry.mjs`. (`bot.json` /
`job-scout.json` no longer carry any WhatsApp or session-hygiene wiring — domain config only.)

**Tool: `shared/tools/registry-sync.mjs`.**
- `--check` — reports drift between registry.json and live state (openclaw.json allowlist+bindings+
  agents.list identity/mentionPatterns/workspace, plus live cron `delivery.to`); exit `0` in-sync / `1` drift.
- `--json` — the same result machine-readable (used by the watchdog).
- `--apply` — writes timestamped backups of BOTH openclaw.json + registry.json to
  `shared/backups/registry-sync/` (pruned to the newest 20), patches openclaw.json **atomically**, sets
  cron targets via `openclaw cron edit --to`, and prints a **gateway-restart reminder only when
  openclaw.json actually changed** (cron-only changes need no restart).

**Workflow for wiring / moving an agent:** edit `shared/registry.json` (a group's `jid`, or the agent's
`groups`/`cronTargets` ref) → `registry-sync --check` (review) → `--apply` → `openclaw gateway restart`
while chat idle. This replaces the old error-prone "edit 4 places by hand" recipe, which missed cron
`delivery.to` and sent poker's 2026-07-17 morning lesson to its OLD group.

**Drift is monitored:** `gateway-watchdog.sh` **CHECK F** runs `registry-sync --check --json` on a throttle
and posts a WhatsApp notice when drift appears (see the "watchdog CHECK F: registry drift" section below).

## Acknowledgment hook (ack-react) — verified 2026-05-27, made shared 2026-06-26
Every inbound WhatsApp message in any wired group gets an automatic 👍 via a gateway
hook (`shared/hooks/ack-react/`, event `message:received`), independent of the
LLM — this replaced the unreliable LLM-driven 👀/✅ indicator. The hook resolves which agent owns the
inbound message by its group jid via the registry (`shared/lib/agent-registry.mjs` `getAgentByGroup`),
so the **single** shared pack serves all 5 bots (it replaced the old per-workspace
`workspace-*/tools/hooks/ack-react-*/` copies). Registered via `hooks.internal.load.extraDirs`
in `~/.openclaw/openclaw.json`, which now holds the single entry `~/open_claw/shared/hooks`
(handlers live in the repo, so they survive `openclaw` upgrades; if `openclaw hooks list` ever stops
showing `ack-react`, re-add the extraDirs entry and restart). Verify: `openclaw hooks list` shows
`ack-react ✓ ready`; send a group message → journal shows `Sent reaction "👍" -> message <id>`.

## Session hygiene — keeps the conversational session small (added 2026-05-30)
The WhatsApp group session is kept small so OpenClaw's (broken) native compactor never runs —
the real fix for the silent-bot/hallucination failure (supersedes the manual "reset oversized
session" runbook below). Mechanism (`workspace-jobscout/tools/session-hygiene.mjs` — now a thin shim that
delegates to the shared engine `shared/lib/session-hygiene.mjs` with agentId `main`; per-agent params
come from `shared/registry.json` — run every 5 min by the `openclaw-session-hygiene.timer` user unit):
- **Metric:** byte size of the active group transcript `.jsonl` (NOT `contextTokens` — that field is
  the constant 1,048,576 = window size, identical on every session, NOT a fullness gauge; verified).
  Reset threshold default 1,000,000 bytes (the `main` agent's `sessionHygiene` block in `shared/registry.json` — moved out of job-scout.json in the registry-v2 refactor).
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
- **Continuity:** the shared `chat-log` gateway hook (`shared/hooks/chat-log/`, events
  `message:received`+`message:sent`; per-agent params derived in `shared/hooks/chat-log/agent-cfg.mjs`
  from the registry) mirrors every group message to an append-only record
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
  `shared/lib/chat-log.test.mjs` (`classify` + collapse). Tunable: `sessionHygiene.recent_window` in the agent's `shared/registry.json` block.
- **Notify:** a short Hebrew message to the group on each reset (toggle `notify_on_reset`).
Verify: `node workspace-jobscout/tools/session-hygiene.mjs --dry-run` (expect `→ noop` today);
`systemctl --user list-timers openclaw-session-hygiene.timer`; `openclaw hooks list` shows
`chat-log ✓ ready`. Tunables live in the agent's `sessionHygiene` block in `shared/registry.json`.

## Phone push notifications suppressed by the bot — "ghost mode" fix (applied 2026-05-30, VERIFIED WORKING)
**Symptom:** while the bot is connected, David gets **no WhatsApp push on his phone in ANY chat**; unlinking restores them.
**Cause:** Scotty is a Baileys **companion device on David's OWN number** (`selfChatMode:true`); WhatsApp routes notifications to the "active" linked device (known Baileys behavior, openclaw issue #30286; fix = presence `unavailable`). On-connect fix was already correct; the leak was the bot flipping back `online` via typing indicator (`composing`), 👍 reactions, and read receipts, never returning to `unavailable`.
**Fix (two parts):**
  1. **Config (survives upgrades):** `channels.whatsapp.accounts.default.sendReadReceipts:false` in `~/.openclaw/openclaw.json`.
  2. **Vendored patch ⚠️ NON-STOCK (an `npm i -g openclaw`/`openclaw update`/plugin reinstall overwrites it — re-apply):** in the WhatsApp monitor bundle `…/extensions/whatsapp/dist/monitor-*.js` (**currently `monitor-DD8bXohk.js`** — the plugin renames it every build; see "⚠️ Vendored patch filenames change per build" below for how to find the current one), inside `attachWebInboxToSocket`, when `selfChatMode`: (a) a 15s interval re-asserts `sendPresenceUpdate("unavailable")` (cleared on `onClose`); (b) `sendComposing` early-returns. Both guarded by `if (options.selfChatMode)` and marked with `[ghost-mode]` comment markers. Backups: `monitor-*.js.bak-prepatch-*` / `monitor-*.js.bak-ghostmode-*`, `openclaw.json.bak-ghostmode-*`. **Re-applied 2026-07-15** after the extension update wiped it — see the dated note below.
**Verify:** re-link (`./openclaw channels login --channel whatsapp`), then with the bot connected send yourself a message from another phone → phone should still get a push. If still suppressed, the single-number approach is exhausted → move Scotty to a **separate number** (clean permanent fix). Single-number ghost mode verified sufficient 2026-05-30; no separate number needed.

## Cross-sender "only the last person answered" — per-conversation turn serialization (applied 2026-06-27)
**Symptom:** in a group, when one person sends several messages in a row the bot answers them fine, but the moment a message from a *different* sender interleaves, the bot answers only the **later** message and silently skips the earlier sender's — one reply is lost.
**Root cause (concurrency race, not `fromMe`/own-number):** the WhatsApp inbound debouncer keys per **sender** (`accountId:conversationKey:senderKey`, in `buildInboundDebounceKey` — line coordinates drift per build; ~`monitor-DD8bXohk.js:732` as of 2026-07-15), so two senders' messages flush as **concurrent** `onMessage` turns on the **same group session**. The per-conversation reply-run lock (`isEmbeddedPiRunActive`, read at `get-reply-*.js`) is registered **late** (after the async preamble) but **checked early**, so the 2nd turn sees "no active run" → `run-now` (`typing-mode-*.js`: `!isActive → run-now`) → both turns run concurrently and collide; the last writer wins, the other reply is lost. Same-sender works because the debouncer merges one sender's burst into a single `combinedBody`/turn. (Config debounce widening only *masks* the race; `collect`/`followup`/`steer` don't help because the 2nd turn never enters the queue.)
**Fix — two parts:**
  1. **Config** (`~/.openclaw/openclaw.json` → `messages`): `inbound.debounceMs:400`, `queue:{mode:"collect",debounceMs:500,cap:30,drop:"summarize"}`. (collect = any residual batch is answered all-in-order; small debounce = snappy.)
  2. **Vendored patch ⚠️ NON-STOCK (an `openclaw update`/plugin reinstall overwrites it — re-apply):** in the WhatsApp monitor bundle `…/extensions/whatsapp/dist/monitor-*.js` (**currently `monitor-DD8bXohk.js`** — renamed per build; see "⚠️ Vendored patch filenames change per build" below), just before `const debouncer = createInboundDebouncer({`, add a per-conversation async mutex (`__convTurnChains` Map + `__serializePerConversation(m, fn)`, marked with `[conv-serialize]` comment markers), and wrap **both** flush calls — `await options.onMessage(last)` and `await options.onMessage(combinedMessage)` — in `await __serializePerConversation(<msg>, () => options.onMessage(<msg>))`. This serializes turns **per conversation**: each message waits for the prior turn in the same group to finish (so its reply is already in history → ordered, building replies; nothing dropped), with a **120s safety cap** so a hung turn can't wedge the conversation. Different conversations still run concurrently. Backups: `monitor-*.js.bak-prepatch-*` / `monitor-ClhD-fQ6.js.bak-serialize-20260627`. Logic unit-tested (sequential same-conv / concurrent diff-conv / hung-turn cap / error-resilience). **Re-applied 2026-07-15** after the extension update wiped it — see the dated note below.
  Also injected into every agent's prompt via the shared reply-policy (rule א): answer every message in `[Chat messages since your last reply - for context]` / `[Queued messages while agent was busy]` that is directed at you, oldest-first — safety net if a message still lands only as context.

## Vendored patch #4 — restore per-inbound `message:received` internal-hook emission for WhatsApp (applied 2026-07-15)
**Symptom:** since the **2026.7.1 upgrade** (installed 2026-07-13 ~18:16) the managed shared internal hooks in `shared/hooks/` that fire on `message:received` — **`ack-react`** (👍) and **`chat-log`** (inbound mirror → `data/chat-log/<jid>.jsonl`) — went **silent for every inbound WhatsApp message, in every bot**: no acks, no inbound chat-log entries. Outbound `message:sent` events kept arriving fine (from `deliver-*.js` / `delivery-*.js`), and `openclaw hooks list` still showed 9/9 ready — the hooks were healthy, they simply received **zero** `message:received` events. (Internal-hooks module `internal-hooks-*.js`: handlers keyed `${type}:${action}`; event shape `{type:"message",action:"received",sessionKey,context,timestamp,messages:[]}` from `createInternalHookEvent("message","received",sessionKey,context)`.)
**Root cause (verified — the seam, `monitor-DD8bXohk.js`):** pre-2026.7.1 the core emitted `createInternalHookEvent("message","received", …)` for every inbound from the channel path. In 2026.7.1 the **WhatsApp channel moved to an extension** (`~/.openclaw/extensions/whatsapp/dist/monitor-*.js`) and per-inbound emission was **dropped by default**. In the new core, `createInternalHookEvent("message","received"` lives only in `dispatch-*.js` and `telegram-ingress-spool-*.js`; the WhatsApp inbound flow does **not** produce a hook event through dispatch, because the extension's accepted-inbound handler (`processMessage` → `buildWhatsAppInboundContext`, `monitor-DD8bXohk.js:~3448`) sets **`suppressMessageReceivedHooks: true`** on the dispatch ctx (→ `SuppressMessageReceivedHooks` at `~:2767`), which the core `dispatch-*.js` emit is explicitly gated on (`if (ctx.SuppressMessageReceivedHooks !== true …)`). The extension **reserved emission for itself** via its own `emitWhatsAppMessageReceivedHooks()` helper (uses `openclaw/plugin-sdk/hook-runtime` — `getGlobalHookRunner`/`triggerInternalHook`, bounded fire-and-forget), but wraps it in `emitWhatsAppMessageReceivedHooksIfEnabled()`, which only fires when `channels.whatsapp[.accounts.<id>].pluginHooks.messageReceived` is set — and that **defaults to `false`** (`shouldEmitWhatsAppMessageReceivedHooks`). Net: the extension suppressed the core emit **and** gated its own off → **neither fired**.
**Fix — vendored patch ⚠️ NON-STOCK (an `openclaw update` / plugin reinstall overwrites it — re-apply):** in the WhatsApp monitor bundle `…/extensions/whatsapp/dist/monitor-*.js` (**currently `monitor-DD8bXohk.js`** — renamed per build; see "⚠️ Vendored patch filenames change per build" below), at the accepted-inbound seam in `processMessage` (just after `buildWhatsAppInboundContext(...)` builds `ctxPayload`), **replace the gated call** `emitWhatsAppMessageReceivedHooksIfEnabled({cfg, ctx: ctxPayload, accountId, sessionKey})` with an **unconditional** call to the extension's own emitter:
```js
// [inbound-hook-emit] VENDORED PATCH #4 …
emitWhatsAppMessageReceivedHooks({ ctx: ctxPayload, sessionKey: params.route.sessionKey });
```
marked with the `[inbound-hook-emit]` comment marker. **Why this seam (not core):** it is the extension's purpose-built emitter on the *guaranteed* accepted-inbound path — reached for **every admitted inbound (dispatch OR observe), post echo-filter, regardless of mention** — and the core dispatch emit is deliberately suppressed for WhatsApp (patching core would fight `SuppressMessageReceivedHooks:true`). `emitWhatsAppMessageReceivedHooks` fires via `fireAndForgetBoundedHook` (bounded, timeout 2s) so it **never blocks or throws into** the inbound turn. The canonical context it builds (`deriveInboundMessageHookContext` → `toInternalMessageReceivedContext`) sets `conversationId = OriginatingTo` = the **group jid**, which is what the shared hooks key on via `getAgentByGroup` — identical to the shape the (now-suppressed) dispatch emit would have produced. **Double-emit safety:** if a future upstream ever un-suppresses the dispatch emit, `chat-log`'s inbound dedup (skip an inbound whose `messageId` is already in the last ~50 jsonl lines — `tailHasMessageId`) drops the duplicate.
**Backup:** `monitor-DD8bXohk.js.bak-inboundhook-20260715` (same dir). **Verify:** `node --check` on the bundle passes; `grep -cF '[inbound-hook-emit]' monitor-*.js` = 1. **Watchdog:** `gateway-watchdog.sh` CHECK E now sentinel-greps `[inbound-hook-emit]` alongside the ghost-mode + conv-serialize markers (same newest-`monitor-*.js`-by-mtime glob) → notice if an upgrade wipes it. **⚠️ RE-APPLY after every `openclaw` core upgrade OR WhatsApp-extension update** (both bump the bundle hash and revert this), together with patches 1 (ghost-mode) + 3 (conv-serialize) in the same bundle.

### Patch #4 extension (2026-07-17) — carry `wasMentioned` + `replyTo*` into the internal hook context (fixes: quote-replies never 👍-acked)
**Symptom:** agent **zorro** (and any `mentions`-scope bot) **answers** quote-replies to its own messages (e.g. a member replying "נקי" to the daily reminder) but **never 👍-acks** them.
**Root cause:** the shared ack hook (`shared/lib/ack-react.mjs::isAddressedToAgent`) prefers an explicit mention flag (`ctx.wasMentioned ?? meta.wasMentioned`) and otherwise falls back to a **wake-word substring** test. A quote-reply contains **no wake word** → classified "not addressed" → no ack. The gateway core DOES flag it: `buildChannelInboundEventContext` sets `ctxPayload.WasMentioned` from `msg.groupMention.wasMentioned` (true for quote-replies to the bot's own account — which is exactly why the bot answers). But the stock `toInternalMessageReceivedContext(canonical)` in `emitWhatsAppMessageReceivedHooks` maps **neither** `ctx.WasMentioned` **nor** the `replyTo*` fields into the internal context, so the flag died at the emit seam.
**Fix — extend the patch #4 surface in `emitWhatsAppMessageReceivedHooks` (~line 3220 of `monitor-DD8bXohk.js`):** materialize the internal context, enrich its `metadata`, then emit it. Marker `[inbound-hook-mention]`. Exact code to re-apply after an upgrade (replaces the inline `toInternalMessageReceivedContext(canonical)` argument):
```js
// [inbound-hook-mention] VENDORED PATCH #4 EXTENSION (2026-07-17) — carry mention/quote signal into
// the internal ctx so ack-react can 👍 quote-replies (no wake word, but WasMentioned=true). Defensive.
const internalCtx = toInternalMessageReceivedContext(canonical);
if (internalCtx && typeof internalCtx === "object") {
	const meta = internalCtx.metadata ?? (internalCtx.metadata = {});
	if (params.ctx?.WasMentioned !== void 0) meta.wasMentioned = params.ctx.WasMentioned;
	if (canonical.replyToId !== void 0) meta.replyToId = canonical.replyToId;
	if (canonical.replyToBody !== void 0) meta.replyToBody = canonical.replyToBody;
	if (canonical.replyToSender !== void 0) meta.replyToSender = canonical.replyToSender;
	if (canonical.replyToIsQuote !== void 0) meta.replyToIsQuote = canonical.replyToIsQuote;
}
fireAndForgetBoundedHook(() => triggerInternalHook(createInternalHookEvent("message", "received", params.sessionKey, internalCtx)), "whatsapp: message_received internal hook failed", void 0, WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS);
```
No `ack-react.mjs` logic change was needed — the explicit-flag-preference branch already existed (a `boolean` flag wins entirely, so `meta.wasMentioned===false` overrides even a wake-word hit); only its docstring was updated (the "mapper carries no flag" note was stale). `handler.js`'s dbg line now also logs `wasMentioned`. **Backup:** `monitor-DD8bXohk.js.bak-ackfix-20260717` (same dir). **Verify:** `node --check` passes; `grep -cF '[inbound-hook-mention]' monitor-*.js` ≥ 1; `cd shared && node --test` green (289/289). **Watchdog:** CHECK E now sentinel-greps `[inbound-hook-mention]` too (a fourth patch marker). **⚠️ RE-APPLY together with the base patch #4 after every core/extension upgrade.**

## Chat reliability — "the chat crashes on my messages" (root-caused 2026-05-27)
**NOT a process crash** (`NRestarts`=0, `Result=success`). The gateway drops a turn only when **restarted mid-reply**: `systemctl restart` SIGTERMs the in-flight `claude -p` child (`KillMode=control-group`) → `Embedded agent failed before reply` → `FailoverError` → silence (`retry/fallback/failover=null`, no drain on SIGTERM). Every dropped reply correlated 1:1 with a SIGTERM; zero were model flakiness. Restart spikes came from the (fixed) `MissingAgentHarnessError` storm + dev sessions restarting while David chatted.
**OPERATIONAL RULE:** do NOT restart the gateway to apply `skills/`/prompt edits — they hot-reload (CLI session auto-resets on `reason=system-prompt`); restarting only drops the in-flight message. Avoid restarting while David is chatting; if you must, check the journal is idle first.
**Hardening 2026-05-27** (`shared/tools/gateway-watchdog.sh`, tests `gateway-watchdog.test.sh`): watchdog now (1) **probes the harness live before restarting** (a transient `MissingAgentHarnessError` no longer triggers a turn-killing restart); (2) **nudges David to resend** ("ההודעה נפלה… תשלח שוב 🙏") on a dropped turn. Cooldown-gated; CHECK B skipped if CHECK A restarted.

### Known failure mode: spurious "your message dropped, resend it 🙏" nudges (root-caused 2026-06-22)
**Symptom:** David occasionally got the CHECK-B nudge ("⚠️ אופס… ההודעה האחרונה שלך נפלה… תשלח אותה שוב 🙏") **without having sent anything** — "מדי פעם", clustering at :27/:57 past the hour.
**Two compounding bugs:**
1. **Root — a failing heartbeat firing every 30 min.** Both `workspace-jobscout/HEARTBEAT.md` and `workspace-realestate/HEARTBEAT.md` shipped with stray template content (a ` ```markdown ` fence + a `## Related` doc link). That counts as a real heartbeat task, so OpenClaw fired the 30-min heartbeat, which tried to **RESUME a pinned, stale session** (`resumeSession=fd410be3ce79`, invalidated by an `auth-epoch` change) and failed instantly every time (`FailoverError` / `Embedded agent failed before reply: Claude CLI failed.`, `durationMs≈800-1600`). Journal evidence: **143/144 heartbeat turns failed** over 3 days; user/cron turns were unaffected (only 1/126 user turns failed) — i.e. Scotty answered David fine, only the heartbeat was broken. **Fix:** reduced both `HEARTBEAT.md` files to **comments-only** → heartbeat disabled (no periodic task exists for either agent; their real schedules are the 08:00 cron + session-hygiene timer). Verify a file is "off": `grep -vE '^\s*#|^\s*$' workspace-*/HEARTBEAT.md` returns **0 lines**.
2. **Amplifier — CHECK B sliding-window race misread heartbeat failures as user drops.** The watchdog scans a 90s window every ~60s; CHECK B's awk tracked an `in_hb` flag off the `cli exec: …trigger=heartbeat` marker line and *defaulted unattributed failures to "user"*. When a tick's window left-edge fell in the ~1.5s gap between a heartbeat's marker (aged out) and its failure lines (still in-window), the failure was counted as a dropped user turn → nudge. Because the heartbeat failed on **every** tick, this race fired regularly. **Fix:** CHECK B now uses **positive attribution** — a failure counts only when a **non-heartbeat** `cli exec:` marker precedes it *in the same window*; an orphaned failure (marker out of window) is left uncounted. Trade-off (acceptable): a genuine user-turn failure whose own marker aged out is also skipped — SIGTERM-killed turns are CHECK A's job and that path messages David anyway. New tests `4b`/`4c` in `gateway-watchdog.test.sh` cover heartbeat-marker suppression + the orphaned-failure race (16/16 pass).
**Takeaway:** a "resend" nudge with no preceding inbound = look for a failing **heartbeat** (`journalctl --user -u openclaw-gateway.service | grep 'trigger=heartbeat'`), not a real dropped message.

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
  2. **~~Vendored patch~~ → now STOCK upstream (as of the current build; verified 2026-07-15):** this guard no longer needs to be hand-applied. The core selection bundle `…/openclaw/dist/selection-*.js` (**currently `selection-8ixiqbew.js`**, was `selection-hR-AeOeU.js`) now natively returns `cli_runtime_passthrough_openclaw` from `selectAgentHarnessDecision` via `isCliRuntimeAliasForProvider` (~`selection-8ixiqbew.js:15292-15328`) instead of throwing for a `*-cli` runtime. **⚠️ CONTINGENT on config:** this stock path only fires because `agents.defaults.cliBackends {"claude-cli":{"command":"claude"}}` is present in `~/.openclaw/openclaw.json` (part 1 above) — if that key is ever removed, `MissingAgentHarnessError` returns and the old vendored selection guard must be re-applied. **Do NOT patch `selection-*.js`** while the config key is present. (History: the hand-applied guard was wiped by an earlier upgrade — RUNBOOK §248, 2026-07-02 — and the config-side `cliBackends` fix alone kept the bots alive; upstream has since absorbed the guard.) Watchdog CHECK E sentinel-greps the `cliBackends["claude-cli"]` config key precisely because this is the load-bearing piece now.
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
Verify: `bash shared/tools/gateway-watchdog.test.sh` (21 pass — see the 2026-06-29 multi-agent overhaul below); `cd shared && node --test lib/session-hygiene.test.mjs` (session-hygiene logic is now in the shared lib — the per-bot `tools/session-hygiene.mjs` is a thin shim); `--force-reset-poisoned` no-ops on a clean session; `systemctl --user is-active openclaw-watchdog.timer` → active. ⚠️ CHECK C's "resend" nudge and single-agent scope described here were SUPERSEDED 2026-06-29 (below).

**PROACTIVE self-heal — ROOT-CAUSE fix for the recurring/daily case (2026-06-08, David: "זה קורה לי הרבה לאחרונה"):** the auto-heal above is *reactive* — it fires only AFTER David hits the error (👍-no-reply, then a resend nudge). Forensics on the archived transcripts pinned WHY it recurs daily: the **08:00 cron scout delivers its per-person reports into the group's CONVERSATIONAL session as assistant turns** (confirmed: `…archived-20260608-093057` = `user=0 assistant=5` — David+guest+the guest reports + the silent `.` + the nudge). The session is **poisoned every morning**, and the 07:30 daily reset runs *before* the scout so it never helps. Adding **the guest** (3 enabled people now) made the morning poison heavier/more reliable → "happens a lot lately". **Fix:** `session-hygiene.mjs` now checks `isPoisoned()` on **every regular timer run** (not only under `--force-*`) and, if the live session is assistant-only, resets it **proactively and SILENTLY** (`decideProactivePoison()`, idle-gate bypassed) — clearing the scout residue *before* David's first message, so he never hits the error. SILENT is essential: a "started a new conversation" notify would itself create a fresh assistant-only session and re-poison (infinite reset↔notify loop). The reactive CHECK C + nudge stays as the backstop for the sub-timer-interval window (and for the *mid-day* variant: a single huge inline turn — e.g. an ad-hoc deep scan — inflates context past the compaction threshold; mitigate by running heavy work via a tool that returns compact JSON, not inline). Verify: `cd shared && node --test lib/session-hygiene.test.mjs` (incl. `decideProactivePoison`; logic now shared, per-bot file is a shim). Note: `tools/self-edit.mjs verify` (via the shim) still runs ALL of that bot's `tools/*.test.mjs` + `tools/lib/*.test.mjs`.

**MULTI-AGENT overhaul + the TRUE root cause (2026-06-29, David: "סקוטי שולח 'תקלה זמנית… תשלח שוב' מדי פעם ואני לא יודע למה"):** two compounding bugs.
1. **Phantom nudge = cross-agent false alarm.** CHECK C grepped the **shared** gateway journal with NO session-key filter, so a poison signature from ANY bot (verified: זורו) made *Scotty's* watchdog force-reset main + post "⚠️ הייתה לי תקלה זמנית… תשלח את ההודעה האחרונה שוב 🙏" in the Job Scout group for a failure that wasn't his. `main` itself hadn't truly poisoned since Jun 8 — every nudge since was another bot's poison surfacing in Scotty's group.
2. **The poison's true trigger = session-ENTRY token overflow** (not byte size). "Preflight compaction required but failed" fires when the session ENTRY's `totalTokens` > `contextTokens` (the 1M window) — verified on זורו: an **empty** transcript yet `totalTokens=1.24M` on the entry (days of daily-cron assistant posts, no hygiene timer to reset it) → every inbound aborted. **Archiving the transcript does NOT cure it** (the killer count lives on the *entry*), and the old `mv + cleanup --fix-missing` reset (a) raced with the rapid retries that recreate the .jsonl, and (b) for non-main bots ran against **main's** store, because `openclaw sessions cleanup` defaults to `--agent <configured default = main>`.

**Fixes (all code, tested, live — no gateway restart):**
- `gateway-watchdog.sh` **CHECK C is now MULTI-AGENT**: it loops every registry agent (`shared/registry.json`), scopes poison detection to each `sessionKey=agent:<id>:`, and heals each via the shared per-agent reset on a **per-agent** cooldown (`watchdog-last-compactreset-<id>`). The "resend" nudge is **REMOVED** — the reset itself posts that bot's own reassuring "started a fresh chat, everything saved" notice. CHECK A (dead harness) stays **global** (a process-wide failure cured only by a restart). One watchdog now heals every bot, each in its own group. Agent enumeration is overridable via `LIST_AGENTS_CMD` (tests).
- `shared/lib/session-hygiene.mjs`: `performReset` now **deletes the session ENTRY** (gated on `sessionKey`) — clears the stale `totalTokens`, immune to the recreate-race; `makeRunCleanupReal` passes **`--agent <id>`** so a non-main reset hits the right store. (Manual one-off cure if it ever sticks: back up `~/.openclaw/agents/<id>/sessions/sessions.json` and delete the `agent:<id>:whatsapp:group:<jid>` entry → next inbound starts fresh at 0 tokens.)
- **Per-agent hygiene timers added for זורו/digit/pitzi** (`openclaw-session-hygiene-{zorro,digit,pitzi}.timer`, every 5 min, boot-staggered 5/6/7 min; ExecStart → each `workspace-*/tools/session-hygiene.mjs` thin shim). Previously **only main + poker** had a timer, so זורו/digit poisoned silently with no proactive clear (both were found poisoned on 2026-06-29 and cleared). All 5 bots now self-heal proactively (the `decideProactivePoison` silent clear); the multi-agent watchdog is the 60s backstop.
Verify: `bash shared/tools/gateway-watchdog.test.sh` (21 pass); `cd shared && node --test` (190 pass); `systemctl --user list-timers | grep hygiene` → 5 timers active.

**DETECTION GAP left by the above fix — root-caused 2026-07-01 (דאוס/poker, David: "עושה לייק ולא מגיב, נפל עד 21:00"):** the 2026-06-29 fix above correctly made *recovery* (`performReset`) robust for the entry-token-overflow shape, but `isPoisoned()` — the function that DECIDES whether a session needs resetting, called from both the proactive 5-min timer and the watchdog's `--force-reset-poisoned` — only ever read the **transcript file** (`users===0 && assistants>0`). It never checked the entry's own `totalTokens`/`contextTokens`, so a session poisoned by pure token-overflow with a genuinely **empty** transcript (nothing ever got appended — every turn aborted before writing) was invisible to it: `poisoned` came back `false` on every check.
**Confirmed live:** poker's evening-quiz cron poisoned the group session at 17:00 UTC as usual (assistant-only content, transcript-detectable) — the routine 5-min proactive heal correctly cleared it at 17:04, exactly as designed. The very next real inbound (17:23) hit the OTHER poison shape immediately: `sessions.json` backup showed `totalTokens: 1,254,397 > contextTokens: 1,048,576` on an entry whose transcript file held only the session-init line — zero messages. For the next 36 minutes the hygiene timer logged `idle=true poisoned=false → noop` every 5 minutes (`journalctl -u openclaw-session-hygiene-poker.service`) — it saw the session was free to touch but its own poison-check said "nothing wrong", so it did nothing. The watchdog's first CHECK C attempt (17:24:19) called `--force-reset-poisoned`, but that call ALSO runs through `isPoisoned()`+idle-gate (`decideForce`): not-poisoned + busy(not idle yet) → `deferred`, no reset — yet the watchdog script logged "force-resetting its session" unconditionally, regardless of the actual outcome, hiding the failure. The session only recovered at 18:02 once ~40 idle minutes had passed and `decideForce`'s **unrelated** "not poisoned but idle → reset anyway" fallback branch happened to fire — i.e. it self-healed by accident, not by correct detection. **In an ACTIVE chat (repeated messages <90s apart) this would never self-heal — idle never becomes true, so it's deferred forever.**
**Fix (code + tests, no gateway restart, no config change):**
- `shared/lib/session-hygiene.mjs`: added `isTokenOverflowed(entry)` — checks `entry.totalTokens > entry.contextTokens` directly on the session-store entry (no I/O beyond the already-loaded store) — and OR'd it into the `poisoned` signal feeding **both** `decideProactivePoison` and `decideForce`, so either poison shape (assistant-only transcript OR entry token-overflow) now bypasses the idle-gate identically. The hygiene log line now prints `poisoned=<bool>(transcript=<bool>,overflow=<bool>)` so future incidents are diagnosable without re-deriving this from raw `sessions.json` backups.
- `shared/tools/gateway-watchdog.sh`: `reset_agent_session` used to discard `session-hygiene.mjs`'s output and always log "force-resetting" even when the call actually deferred — now captures the real `→ RESET/DEFER/noop` line (and `reset OK`/`RESET FAILED`) and logs it, so the journal reflects what actually happened.
- Applies to **all 5 bots** (shared lib, not poker-specific) — any bot can hit this same detection gap.
Verify: `cd shared && node --test` (204 pass, incl. `isTokenOverflowed` unit tests + a `runHygiene` integration test replicating this exact incident — empty transcript, overflowed entry, busy chat → must still reset); `bash shared/tools/gateway-watchdog.test.sh` (21 pass).

**CRON FINALIZE vs HYGIENE REWRITE + assistant-only MISFIRE — root-caused 2026-07-15 (David: at the END of Scotty's morning scout the group gets `⚠️ Cron job "job-scout-daily" failed: CronSessionLifecycleClaimError`).** Two compounding bugs, both a fallout of the 2026.7.1 upgrade (which stopped delivering inbound non-mention messages to sessions, making assistant-only sessions the NORM, not a poison symptom):
1. **The assistant-only heuristic now MISFIRES every run → a 5-minute reset LOOP.** After the daily reset, Scotty's group session holds ONLY his own outbound cron digests (members rarely @-mention him), so `isPoisoned()` (assistant-only, 0 user turns) returned `true` on a perfectly healthy, tiny, under-cap session — and `decideProactivePoison()` reset it SILENTLY every single hygiene tick, idle-gate bypassed. Journal: `06:12:01 … poisoned=true(transcript=true) → RESET`, `06:17:11 … → RESET` again, etc.
2. **A mid-run hygiene reset kills the in-flight cron's lifecycle claim.** OpenClaw 2026.7.1 guards each isolated cron run's `agent:<id>:cron:<uuid>` store entry with a `lifecycleRevision` claim (`dist/run-session-state-r5DnSgVq.js` → `createPersistCronSessionEntry`: at finalize it re-reads `sessions.json` and throws `CronSessionLifecycleClaimError` unless the on-disk entry still owns the run's revision). `performReset` runs `openclaw sessions cleanup --agent <id> --fix-missing --enforce`, and `--fix-missing` = "remove store entries whose transcript files are **missing**." The in-flight cron entry has a `sessionId` but **no on-disk transcript**, so the mid-run reset PRUNED it → the finalize found the entry gone (`currentEntry===undefined` → `ownsCurrentRevision=false`, `canClaimInitialRevision=false`) → threw, and `delivery.mode:announce` posted the error text into the group. **Backup-diff proof:** the 06:12 pre-write backup (`sessions.json.bak-20260715-091200`) held both cron keys; the 06:17 backup had the `5d7587f3` entry GONE — the ONLY key removed between the two resets (the group keys and every other entry round-tripped byte-exact). Cron ran 06:03:56→06:15:58 (722 s); the 06:12:04 reset fell inside it. **NOT an mtime bug:** the claim compares the entry's `lifecycleRevision` VALUE (and an in-memory admission map), not the file mtime, so a *byte-identical* rewrite would still pass — the load-bearing failure is the cleanup **deleting** the entry, hence the fix is to skip the reset (and its cleanup) entirely while a cron run is live.
**Fix (code + tests, no gateway restart, no config change) — `shared/lib/session-hygiene.mjs`:**
- **A. Assistant-only alone is HEALTHY.** New pure `isTranscriptPoisoned({assistantOnly, compactionMarker, sizeOverflow, tokenOverflow})`: a transcript counts as poisoned ONLY when assistant-only AND corroborated by a GENUINE signal — a compaction marker (new `hasCompactionMarker()`, detects `role:"compactionSummary"` / `isCompactSummary` / `compact_boundary`), the size cap, or entry token-overflow. A merely assistant-only, under-cap session → noop (loop stops). Token-overflow stays independent poison; `--force-reset-poisoned` still requires confirmed poison, so it is unaffected.
- **B. Cron-safety.** New pure `findActiveCronKey(store, cronKeyPrefix, nowMs, windowMs)`: an IN-FLIGHT cron entry carries a live `lifecycleRevision` (a finalized entry has none); `runHygiene` reads the store once up front and, if a cron run of the agent is active, DEFERS the whole run (`deferred: cron run active`) — no store rewrite, no `sessions cleanup`, no notify. `updatedAt` is stamped at run start (not bumped mid-run) so it is only a staleness guard; window default 30 min (`cron_active_window_secs`) must exceed the longest cron run. The delete-and-rewrite is already byte-exact for untouched entries (JSON round-trip carries unknown fields + key order through — locked by a new test); B's skip-while-active is the load-bearing fix.
- The hygiene log line now prints `poisoned=<b>(transcript=<b>[assistantOnly,compactionMarker,size],overflow=<b>)`.
- Applies to **all 5 bots** (shared lib). Verify: `cd shared && node --test lib/session-hygiene.test.mjs tools/session-hygiene.test.mjs` (61 pass, incl. assistant-only-healthy→noop, assistant-only+marker→reset, cron-active→defer, and round-trip-preserves-unknown-fields). Next hygiene tick after the fix logs `noop` on the (now healthy) assistant-only session instead of `RESET`.

## Known failure mode: "an agent crashed and took the others down" — actually a full-HOST reboot (root-caused 2026-06-15)
**Symptom (David: "הסוכן דאוס קרס... זה גם השפיע על הסוכנים האחרים שהפסיקו לעבוד"):** one agent (here: דאוס/poker) suddenly stops responding mid-chat AND so do all the others, at the same moment.
**Cause:** NOT an agent/OpenClaw bug. **The whole machine rebooted.** All 4 agents (סקוטי/main, דיגיט/digit, דאוס/poker, פיצי/pitzi) run behind ONE shared gateway on ONE host, so a host reboot drops all of them together for the ~6–7 min the gateway takes to come back. This host is **multi-tenant** — another user (`<other-tenant>`, has sudo) can reboot it. Confirmed instance: `Jun 15 22:35 UTC` (= 01:35 Asia/Jerusalem) the admin ran, via sudo, `systemd-run --on-active=2s --unit=claude-reboot systemctl reboot` (David confirmed: done to bring up a VPN). Graceful shutdown (`Stopping openclaw-gateway.service` → SIGTERM in the journal), not a crash/panic. **Out of our control** (no root; another tenant owns the box).
**Diagnose:** `last reboot` (was there a boot boundary?); `sudo journalctl --since … | grep -iE 'reboot|will reboot now|claude-reboot'` to see WHO/WHY; user journal `journalctl --user -b -1 -n 80` tail shows a graceful `SIGTERM received` (planned) vs an abrupt cut (crash/power-loss). The `qxl/[TTM] Buffer eviction failed` kernel lines are virtual-GPU VRAM noise, unrelated.
**Recovery is already automatic (verified):** gateway service is `enabled` + `WantedBy=default.target`, user `Linger=yes` (starts at boot with no login), `Restart=always RestartSec=5`. So every reboot self-heals — agents came back on their own; no fix needed in our stack.
**Reduce confusion (APPLIED 2026-06-15):** `shared/tools/boot-notify.mjs` + `~/.config/systemd/user/openclaw-boot-notify.service` (oneshot, `After=openclaw-gateway`, `WantedBy=default.target` → fires once per real boot, NOT on a gateway restart). It waits (retries ~20 min) for the gateway+WhatsApp to be ready, then posts ONE Hebrew message to the Job Scout group: "🔄 המערכת עלתה מחדש אחרי reboot… כל הסוכנים פעילים ✅", incl. boot time (Asia/Jerusalem) and a graceful-vs-abrupt shutdown heuristic (from `journalctl --user -b -1`). So a host reboot is never again mistaken for an agent crash. Idempotent per boot (keyed on `/proc/stat` btime → `~/.openclaw/boot-notify.state`; `/tmp` is NOT tmpfs here so we don't rely on it being wiped). Test without a reboot: `node shared/tools/boot-notify.mjs --dry-run` (prints, sends nothing); live one-off: `systemctl --user start openclaw-boot-notify.service`. Hard rule #1 preserved — only ever targets the Job Scout group.

## Known failure mode: whole VM freezes / RAM exhausted — dev-side claude+MCP sprawl, NOT the bots (root-caused 2026-06-22)
**Symptom:** every so often all RAM fills, the VM thrashes and becomes unusable (can't type/run anything), or an agent suddenly stops responding. Feels disproportionate to the real load.
**The box is structurally undersized for its tenants:** 5.8 GiB RAM, 4 cores, one 3.8 GiB swap file. It runs the always-on OpenClaw gateway (4 agents) **plus** David's Cursor-remote dev env **plus** another tenant. `Committed_AS` sits ~2.15× over `CommitLimit`.
**Root cause (forensics, NOT the agents):** the OpenClaw gateway is a single, **non-leaking** process (~430 MB RSS, VmHWM ~780 MB; cron sessions exit & archive cleanly within minutes — verified). The memory hog is the **dev side, ~9.6:1 over the whole bot fleet**: 5–6 concurrent interactive `claude` CLI sessions in Cursor terminals (each ~200–400 MB) and, critically, a **process leak** — every `claude` session spawns its own MCP sidecars (`mongodb-mcp-server` + `context7-mcp`; `mongodb` is a **global** `mcpServers` entry in `~/.claude.json`, so it loads in *every* session). When a session dies the sidecars are **not reaped** → reparented to init (PPID=1) and keep holding RAM/swap. They accumulate (saw 7–8 orphans, oldest 3 h old). **Mechanism = thrash-then-OOM:** swap fills (`pswpout` millions of pages, IO-PSI `full avg300≈48%`), then the kernel OOM-killer fires (`/proc/vmstat oom_kill`>0). On 2026-06-21 20:17 it killed the **gateway itself** (`Failed with result oom-kill`, NRestarts=1) — the gateway is the biggest single target and was **uncapped** (`MemoryMax=infinity`), so a host-wide OOM takes all 4 agents down even though they didn't cause it.
**Diagnose:** `free -h` (swap near-full?); `grep -E 'oom_kill|pswpout|pgmajfault' /proc/vmstat` (kills + thrash); `cat /proc/pressure/io` (`full avg*` = % time stalled on swap IO); `ps -u $USER -o pid,ppid,rss,etime,args | awk '$2==1' | grep mcp-server` (orphaned sidecars); `sudo -n journalctl -k | grep -i 'killed process'` (who died); `systemctl --user show openclaw-gateway.service -p MemoryCurrent -p MemoryPeak -p MemoryMax`. **Exonerated** (checked, innocent): cron overlap, session transcripts (~12 MB), logs/journal (capped), tmpfs/shm (empty), PageTables (~140 MB).
**Fixes APPLIED 2026-06-22 (user-scoped, no sudo, no gateway restart, reversible):**
  1. **Orphan-MCP reaper:** `~/.local/bin/mcp-orphan-reaper.sh` + `mcp-orphan-reaper.{service,timer}` (every 10 min). Kills only PIDs re-confirmed PPID=1 + own-uid + cmdline matches `mcp-server|context7-mcp` (a live session's sidecars are direct children, PPID≠1, so never matched). SIGTERM→3 s→SIGKILL (these sidecars **ignore SIGTERM**, need KILL). Logs to `~/.local/state/mcp-orphan-reaper.log`. Verify: `systemctl --user list-timers mcp-orphan-reaper.timer`.
  2. **Gateway memory cap (blast-radius containment):** `systemctl --user set-property openclaw-gateway.service MemoryHigh=2.5G MemoryMax=3G` (live + persistent drop-in under `~/.config/systemd/user.control/`; kernel `memory.max` now 3 GiB, was `max`). Normal peak is 2.0 GiB so legit work is untouched; a runaway (the 5 GB Jun-21 case) now hits a **cgroup**-OOM at 3 G — contained to the gateway, not a host-wide freeze. Revert: `systemctl --user revert openclaw-gateway.service`. (Optionally on a future natural restart, drop the gateway's `OOMScoreAdjust` from +200 so it's not the preferred global-OOM victim — needs a restart, so not forced.)
**Still on David's side (recommendations, not auto-applied):** close idle Cursor terminals / surplus `claude` sessions (biggest lever, ~2 GB); move `mongodb` out of **global** `~/.claude.json` `mcpServers` into per-project scope so casual sessions don't each carry a Mongo+Upstash sidecar; host-wide `vm.swappiness` 60→10 (needs sudo, affects the other tenant); ultimately the box wants more RAM. **Takeaway:** RAM-fill/freeze on this host = look at the **dev-side `claude`/MCP population first** (`ps ... mcp-server` orphans, count of interactive `claude`), not the bots — the gateway is almost always innocent.

## Known failure mode: a cron `announce` agent "reports it sent" instead of sending the content (root-caused 2026-06-27, זורו)
**Symptom:** a daily `announce` cron "runs ok" but the group receives a **status report** ("בעיטת הבוקר נשלחה ✅ / פריט: … / נשלח ל: …") instead of the actual message. The real content never arrives, yet `sent.jsonl`/logs say it did. Happened 2/2 mornings → not a fluke.
**Root cause:** with `delivery.mode: announce`, **the agent's FINAL turn text is what gets posted to the group, verbatim.** When the cron message tells the agent to "send the morning kick **and record what you sent**", the model (a) calls `message send` itself mid-turn — which goes to the wrong target / nowhere useful — and (b) makes its **final text a meta-narration** ("…נשלח ✅") to satisfy the "record" instruction. Announce then posts that narration. Journal signature: two `Sending message` lines per run, one to a **non-group** recipient (the agent's own `message send`) and one to the group (the announce of the status text). Decode the hashed `sha256:…` targets with `printf '%s' '<jid>' | sha256sum | cut -c1-12` to confirm which got what.
**Fix (the robust, model-independent pattern — applied to זורו):**
  1. **Move all bookkeeping into a deterministic tool**, so the model never "records by narrating". `workspace-quitsmoke/tools/morning-kick.mjs` picks the next unsent content item, **writes `sent.jsonl` itself**, and returns `{fact, leaderboard, pending}` as JSON. Idempotent per day. The model's only job is to rephrase one `fact` in voice and emit it.
  2. **State the announce contract explicitly** in the cron message AND the injected prompt: *"your final text is posted verbatim → output ONLY the message; never write a report/'sent ✅'; never call `message send` for the text (that targets wrong + leaves the group with the report)."* (In `prompt-daily.md` + `AGENTS.md` "☀️ בעיטת הבוקר".)
  3. Edit the cron message with `openclaw cron edit <id> --message "…"` (back up `~/.openclaw/cron/jobs.json` first). Isolated cron sessions reload prompt files fresh each run, so no restart needed.
**Generalizes:** any agent on `announce` cron (Scotty job-scout, poker) has the same exposure — the rule "final text = the message, never a status line, never a redundant `message send`" applies fleet-wide. If a future bot does this, prefer the deterministic-tool pattern over trusting prompt discipline (prompt discipline alone failed here even though `prompt-daily.md` already warned against it).

## Shared cron architecture — the permanent, fleet-wide fix (2026-06-29)
The failure above recurred on **poker** (דאוס): the morning-lesson cron asked the agent to *compose → log → deliver*, so `announce` shipped its status line (`"Lesson 6 delivered and logged…"` / `"שיעור #5 נשלח…"`) and the real lesson **never arrived** (Dor never got lessons 5–6 — they were only logged to `memory/dor-lessons.md`); the daily joke shipped a meta-preamble (`"הפלט הסופי יישלח אוטומטית… ---"`). Per the "prefer deterministic-tool over prompt discipline" lesson, the pattern was **factored into `shared/` and every cron agent now follows it**:
- **`shared/lib/cron-contract.mjs`** — the SINGLE source of the announce contract (Hebrew). `withContract(body)` for DYNAMIC crons (the agent composes); `feedEchoMessage(cmd)` for FIXED-content crons (the agent only echoes a tool's stdout). One edit here fixes every bot — same model as `shared/lib/reply-policy.mjs`.
- **`shared/lib/cron-feed.mjs` + `shared/tools/cron-feed.mjs`** — generic deterministic content-feed walker: `node shared/tools/cron-feed.mjs --agent <id> --feed <name> [print|peek|status]`. Reads `<workspaceDir>/data/feeds/<name>.json` (`{items:[{text}]}`) + `<name>.state.json`, prints the next item **verbatim**, advances + wraps, logs to `<name>.log`. No LLM in the content path → nothing (English/meta/"sent ✅") can leak. Validates non-empty Hebrew before shipping.

**Rule for every future cron:** FIXED, pre-authored content (poker lesson/quiz) → author a feed JSON + point the cron at `feedEchoMessage(cron-feed … print)`, `--light-context --tools "exec read"`. DYNAMIC content (a tool returns data, the agent writes in-voice — scout, weekly-review, zorro morning-kick, poker teder roast) → the tool OWNS state, the cron body ends with `withContract(...)`. **Never** ask the cron agent to compose-and-log in one turn.

**Migrated 2026-06-29** (verified end-to-end via `openclaw cron run <id>` — delivered text = the clean lesson/joke, not a status line). All three **poker** crons use the DYNAMIC pattern (David wanted lessons that never stop, count up, and never repeat, + jokes that rotate forever):
- `dor-poker-morning-lesson` (08:02 wkdays, full-context) → `tools/dor-lesson.mjs next` walks `data/dor-syllabus.json` (37 topics, then endless distinct "advanced scenario" lessons), counts the lesson # up forever (seeded `count:6` → next #7), and passes a `covered` "do-NOT-repeat" list (seeded with the ~20 hands taught in lessons 1–6) so nothing repeats. Agent writes the lesson; `data/dor-lesson-state.json` records `last_topic`.
- `dor-poker-evening-quiz` (20:00 wkdays, full-context) → `tools/dor-quiz.mjs` reads `last_topic` and the agent writes a 4-option quiz on THAT morning's lesson (no answer revealed).
- `dor-teder-daily` (08:08 daily, light-context) → `tools/dor-teder.mjs next` rotates all 9 group members forever (wraps), agent writes the roast.
Also **zorro-daily** (inline contract → shared) + **scotty job-scout-daily + weekly-review (contract was MISSING → added** — the §175 "leaked English recap" exposure). The FIXED-content `cron-feed` path remains available shared infra (poker briefly used it, then moved to dynamic for infinite/non-repeating content). digit/pitzi have no crons. Tests: `cd shared && node --test` (incl. `cron-feed`/`cron-contract`) + `workspace-poker` `node --test tools/lib/*.test.mjs` (incl. `dor-lesson-dyn`/`dor-teder`). Edit a cron message with `openclaw cron edit <id> --message "$(cat msg.txt)"` (back up `~/.openclaw/cron/jobs.json` first); tool allow-list persists under `payload.toolsAllow`; no gateway restart. ⚠️ **`--cron <expr>` WITHOUT `--tz` resets the schedule to the host TZ (Etc/UTC here) — always pass `--tz Asia/Jerusalem` when changing a schedule, or the job fires 2–3h off (UTC+2 in winter/IST, UTC+3 in summer/IDT — so the exact skew depends on DST, and a job pinned to the wrong absolute UTC hour silently drifts an hour when the clocks change).** ⚠️ **Same rule for systemd `--user` timers: an `OnCalendar=` that must fire at an Israel wall-clock time MUST carry the IANA tz token, e.g. `OnCalendar=*-*-* 20:00:00 Asia/Jerusalem` (verify with `systemd-analyze calendar '*-*-* 20:00:00 Asia/Jerusalem'`). A bare `OnCalendar=*-*-* 20:00:00` is interpreted in the host TZ (UTC) and drifts by an hour across DST. The openclaw-zorro-remind-pending / openclaw-zorro-sheet-sync / openclaw-reflect timers were pinned with the token 2026-07-17.**

## Known failure mode: example names in an INJECTED file leak as if real (root-caused 2026-06-27, זורו)
**Symptom:** the bot kept adding non-existent members (שרה, דני) to the Google Sheet / leaderboard, though `data/streaks/members.jsonl` only had the real two.
**Root cause:** `AGENTS.md` (an **injected** file) illustrated the table format with *"1. דני — 12 ימים / 2. שרה — 5 ימים"*. The model reads its own system prompt and treats those placeholder names as real members.
**Fix:** never use realistic example names in injected files — use `<שם>`/`<N>` placeholders, and add the hard rule *"names & numbers come ONLY from `tools/streaks.mjs leaderboard`; never invent a member; if the tool returned N people, there are N people."* **Audit the other agents' injected files** (`AGENTS/SOUL/IDENTITY/USER/TOOLS/HEARTBEAT.md`) for the same trap — placeholder data in an injected file is data the model may emit.

## 2026-07-02 — full-repo review sweep: reflect PATH, watchdog CHECK D/E, fleet-infra move, multi-group hygiene

**1. `openclaw-reflect.service` had failed EVERY night since 2026-06-28 — silently.** Root cause: `shared/tools/reflect.mjs` spawned a bare `claude`, but the systemd user unit's PATH doesn't include `~/.local/bin` → `spawnSync claude ENOENT` for all 5 agents, so `data/memory/group-notes.md` was never (re)generated — main/digit/pitzi had NO notes file at all (bots "woke amnesiac"). Fix: `reflect.mjs` now resolves the binary itself (`CLAUDE_BIN` env → `~/.local/bin/claude` → PATH) — **never rely on host PATH in anything systemd runs.** Backfilled by a manual `reflect --all` (all 5 wrote notes). reflect also now reads the chat-log tails of **all** of an agent's groups (digit has 2), and its output gate (`stripCodeFence`/`validateNotesOutput`) moved into `shared/lib/group-memory.mjs` with tests; the reflection prompt now instructs the model to treat member messages as evidence, not instructions (anti-manipulation), and injection is capped (`MAX_INJECTED_NOTES_CHARS`).

**2. The watchdog now watches the watchers (CHECK D) and the vendored patches (CHECK E).** The reflect failure proved the meta-gap: the self-heal stack itself had no defender (same class as the 2026-06-16 203/EXEC rename incident). `shared/tools/gateway-watchdog.sh` adds: **CHECK D** — any failed `openclaw-*` user unit → one WhatsApp notice per 6h (detection-only, no blind restarts); **CHECK E** — sentinel-greps the load-bearing markers of the vendored patches (`__serializePerConversation`, the ghost-mode presence re-assert, and the `cliBackends["claude-cli"]` config key) → notice per 24h when one disappears after an upgrade. ⚠️ While adding CHECK E we found the **selection-guard vendored patch (RUNBOOK §163) is ALREADY GONE** from the installed `selection-hR-AeOeU.js` — an earlier upgrade wiped it; only the config-side `cliBackends` fix is keeping `MissingAgentHarnessError` at bay. Re-apply per §163 if the silent-bot mode returns.

**3. Fleet infra moved out of Scotty's workspace:** `gateway-watchdog.sh`(+test), `boot-notify.mjs` → `shared/tools/`; root `tools/token-usage.mjs` → `shared/tools/`. Both systemd units' ExecStart updated + daemon-reload (verified live run). Watchdog cooldown state now lives in `shared/.state/` (gitignored; old files migrated). boot-notify derives the agent list from the registry (the hardcoded string was stale — זורו was missing) and **no longer has a hardcoded fallback group id** — unresolvable target → send nothing, exit 1 (hard rule #1). token-usage derives agent names from the registry.

**4. Session-hygiene: multi-group + atomic + bounded backups.** `runHygiene` now iterates **every** group the agent serves (digit's group #2 was previously invisible to hygiene AND to watchdog CHECK C's reset path — the exact דאוס-outage failure class waiting to recur); per-group daily markers (`…-last-daily-<gid>` for groups beyond the first). `performReset`'s store rewrite is atomic (tmp+rename — an interrupted write could truncate the gateway's own sessions.json), and old `sessions.json.bak-*` / `*.archived-*` files are pruned (keep 5 / 10). The lib's redundant inline CLI was removed — the ONE entry point is `shared/tools/session-hygiene.mjs`.

**5. Registry now truly single-source.** `agentCfgFromRecord` no longer returns null for an unknown agentId (a 6th bot used to get a silent no-op chat-log); it derives working defaults from persona/owner, overridable via an optional registry `chatLog` block. `selfEdit` + `sessionHygiene.notify_message` are likewise registry-configurable (legacy tables/switch remain as exact-match defaults for the original five). `sessionHygiene` knobs: workspace config wins per-key, registry block is the fallback layer. chat-log's people-roster matching reads `roster.peoplePath` directly (the shared lib no longer imports from workspace-jobscout).

**6. Shared helpers extracted** (were 3–4 hand copies each): `shared/lib/time.mjs` (`todayInTz` — fixed zorro's UTC date bug: a 00:00–03:00 check-in was stamped on the previous day), `shared/lib/fs-atomic.mjs` (atomic writes — poker/zorro/pitzi/jobscout ledgers + the session store), `shared/lib/sheet-webhook.mjs` (ONE Apps-Script client with timeout — the zorro/pitzi copies had none and could hang a turn).

Verify: `cd shared && node --test` (225 pass) · `bash shared/tools/gateway-watchdog.test.sh` (30 pass) · per-workspace suites green · `node shared/tools/reflect.mjs --agent <id> --dry-run` · `systemctl --user --failed 'openclaw-*'` empty.

## ⚠️ Vendored patch filenames change per build — how to find the current ones

The two files that carry (or, for the harness fix, used to carry) vendored patches are content-hashed
bundle names that the plugin/core **rewrites on every build**, so any hardcoded name in this runbook
goes stale after an upgrade. **Never trust a literal filename here — resolve the live one:**

```bash
# WhatsApp monitor bundle (ghost-mode + per-conversation-serialization patches live here) —
# this one IS under ~/.openclaw (installed extension):
ls -1t ~/.openclaw/extensions/whatsapp/dist/monitor-*.js | head -n1
# Core selection bundle (harness-decision logic; now STOCK, do not patch) — this one is NOT under
# ~/.openclaw: it's in the globally-installed openclaw package under nvm node 22 (the ./openclaw
# launcher's node). Resolve it via the CLI binary so it survives node-version bumps:
OCROOT="$(dirname "$(dirname "$(realpath "$(PATH=~/.nvm/versions/node/v22*/bin:$PATH command -v openclaw)")")")/lib/node_modules/openclaw"
ls -1t "$OCROOT"/dist/selection-*.js | head -n1
grep -l selectAgentHarnessDecision "$OCROOT"/dist/selection-*.js   # pick the one that matches
```
(As of 2026-07-15 the selection bundle resolves to
`~/.nvm/versions/node/v22.22.3/lib/node_modules/openclaw/dist/selection-8ixiqbew.js`.)

Known-current names (as of **2026-07-15**): monitor = **`monitor-DD8bXohk.js`** (was `monitor-ClhD-fQ6.js`),
selection = **`selection-8ixiqbew.js`** (was `selection-hR-AeOeU.js`). `gateway-watchdog.sh` CHECK E now
resolves the monitor bundle by this same glob (newest `monitor-*.js`) rather than a hardcoded name — see
the dated note below.

## 2026-07-15 — vendored patches re-applied after a WhatsApp extension update wiped them

A plugin/extension update bumped the bundle hashes (monitor `ClhD-fQ6`→`DD8bXohk`, selection
`hR-AeOeU`→`8ixiqbew`) and **wiped the two vendored monitor patches** (no `.bak` survived in `dist/`).
Restored + reconciled:

- **Patch 1 (ghost mode) — RE-APPLIED** to `monitor-DD8bXohk.js` (backup `monitor-DD8bXohk.js.bak-prepatch-20260715`
  in the same dir). Both parts restored, guarded by `if (options.selfChatMode)`, marked `[ghost-mode]`:
  (a) the 15s `setInterval` re-asserting `sendPresenceUpdate("unavailable")` (via `getCurrentSock()`, `.unref()`ed,
  cleared on `onClose`) — this is the exact `Promise.resolve(s.sendPresenceUpdate("unavailable"))` string CHECK E
  greps for; (b) the `selfChatMode` early-return at the top of `sendComposing`. Stock on-connect single
  presence line was left as-is. `node --check` passes.
- **Patch 3 (per-conversation turn serialization) — RE-APPLIED** to the same bundle, marked `[conv-serialize]`:
  `__convTurnChains` Map + `__serializePerConversation(m, fn)` (async mutex, 120s safety cap, per-conversation key
  `accountId:conversation.id`) inserted just before `const debouncer = createInboundDebouncer({`, with both flush
  calls (`options.onMessage(last)` and `options.onMessage(combinedMessage)`) wrapped. `node --check` passes;
  `grep -c "__serializePerConversation"` = 3 (definition + 2 calls).
- **Patch 2 (harness de-registration guard) — NOT re-applied; now STOCK.** The current `selection-8ixiqbew.js`
  natively passes a `*-cli` runtime through (`isCliRuntimeAliasForProvider` → `cli_runtime_passthrough_openclaw`,
  ~lines 15292-15328) instead of throwing `MissingAgentHarnessError`. **This is CONTINGENT on
  `agents.defaults.cliBackends {"claude-cli":{"command":"claude"}}` staying in `~/.openclaw/openclaw.json`** (verified
  present). If that config key is ever dropped, the silent-bot failure returns and the old selection guard (§163)
  must be re-applied. `openclaw.json` was NOT touched.
- **Watchdog CHECK E — glob fix.** `shared/tools/gateway-watchdog.sh` hardcoded `MONITOR_JS=…/monitor-ClhD-fQ6.js`,
  so after this rename CHECK E falsely reported `whatsapp-monitor-file-missing` instead of grepping the sentinels.
  Now `MONITOR_JS` defaults to `resolve_monitor_js()` = newest `~/.openclaw/extensions/whatsapp/dist/monitor-*.js`
  by mtime (still `MONITOR_JS`-env-overridable for tests) so it survives future renames.

Verify: `node --check` on the monitor bundle passes; `grep -c "__serializePerConversation"` = 3 and
`grep -cF 'Promise.resolve(s.sendPresenceUpdate("unavailable"))'` = 1; `bash shared/tools/gateway-watchdog.test.sh`
= 30/30 pass; `bash -n shared/tools/gateway-watchdog.sh` clean. Gateway NOT restarted (orchestrator does the single
clean restart).

## 2026-07-17 — watchdog CHECK F: registry drift (registry.json vs live config/cron)

`shared/tools/gateway-watchdog.sh` gained **CHECK F** — a config-drift guard. It runs
`node shared/tools/registry-sync.mjs --check --json` (the tool that diffs `shared/registry.json` — the
single source of truth — against the LIVE `~/.openclaw/openclaw.json` **and** the live cron delivery
targets; exit 0 in-sync / 1 on drift, `--json` prints `{ok, driftCount, …}`). Drift means the checked-in
registry and what the gateway actually runs have diverged (e.g. a hand-edit to `openclaw.json`, or a cron
`--to` target that no longer matches) — a class of silent misconfig nothing else caught.

- **THROTTLED — once / 30 min** (`$STATE_DIR/watchdog-last-registrycheck`): registry-sync shells the
  `openclaw` CLI for the cron list (~6s boot), far too heavy for the 60s watchdog tick, so most ticks skip
  CHECK F silently. It records the run-cooldown up-front (even on failure) so it can't re-run every minute.
- **On drift (exit 1):** logs `registry-sync: DRIFT detected (N drift(s))` on **every** throttled-in run
  while drift persists, and WhatsApp-notifies the owner group (Scotty's) **at most once / 6h**
  (`watchdog-last-registrydrift`, same pattern as CHECK D's failed-units cooldown): `⚠️ registry-sync:
  נמצא דריפט … הרץ node shared/tools/registry-sync.mjs --check … ו---apply לתיקון`. Fix with
  `node shared/tools/registry-sync.mjs --apply` (backs up + patches; restart the gateway while idle only
  if `openclaw.json` actually changed).
- **On tool failure (any non-0/1 exit — missing node, crash):** logs a `WARN` and swallows it — never
  notifies, never fails the watchdog run (best-effort, like the other checks).
- **Testability:** the invocation is env-overridable via `REGISTRY_SYNC_CMD` (same convention as
  `FAILED_UNITS_CMD`/`LIST_AGENTS_CMD`) so `gateway-watchdog.test.sh` stubs it for the in-sync / drift /
  duplicate-suppressed / tool-failure paths.

Verify: `bash shared/tools/gateway-watchdog.test.sh` = 44/44 pass; `bash -n shared/tools/gateway-watchdog.sh`
clean; a real DRYRUN watchdog run against live state exercised CHECK F read-only (currently in-sync → no
notify, run-cooldown file written). No gateway restart, no `openclaw.json`/credentials edits, no real sends.
