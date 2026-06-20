# Deterministic 👍 Acknowledgment Hook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Scotty react 👍 to every inbound WhatsApp message in the Job Scout group instantly and reliably, via a gateway hook independent of the LLM.

**Architecture:** A directory hook-pack (`HOOK.md` + `handler.js`) under `workspace/tools/hooks/ack-react/` listens on the OpenClaw internal `message:received` event. The handler filters to the configured Job Scout group, then shells `openclaw message react … --emoji 👍`. It is registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` so it survives `openclaw` upgrades (the handler lives in `workspace/`, only a path reference lives in config). The dead LLM-driven 👀/✅ instructions are removed from the prompts, and `SKILL.md` rule #8 gains a "say plainly what needs a dev session" clause.

**Tech Stack:** Node 22 ESM, `node:test` built-in runner (zero deps), OpenClaw 2026.5.22 hook system, `openclaw message react` CLI.

**Spec:** `docs/superpowers/specs/2026-05-27-deterministic-ack-react-design.md`

---

## Reference facts (verified against the running system — do not re-derive)

- **Hook event shape** (`dist/internal-hooks-*.d.ts`): `message:received` event = `{ type:"message", action:"received", timestamp, sessionKey, context: { channelId, conversationId?, messageId?, from, accountId?, metadata? } }`. Handler is the **default export**, signature `async (event) => {}`.
- **Hook-pack discovery**: a directory containing `HOOK.md` (YAML frontmatter with `metadata.openclaw.events`) + `handler.js`. Registered by adding the **parent** directory to `hooks.internal.load.extraDirs`. The bundled `command-logger` pack is the canonical template (`~/.nvm/versions/node/v22.22.3/lib/node_modules/openclaw/dist/bundled/command-logger/`).
- **Group reaction works with just target+message-id** (no `--participant`): gateway logs show `Sent reaction "👍" -> message <id>` succeeding in the group `120363000000000000@g.us`.
- **Group jid / config**: `workspace/.config/job-scout.json` → `whatsapp.group_id` = `"120363000000000000@g.us"`. Inbound group messages arrive with `conversationId === "120363000000000000@g.us"`.
- **Launcher**: `/home/davidtobol2580/open_claw/openclaw` (bash → nvm use 22 → openclaw CLI). The gateway already runs on node v22.
- **`message react` flags**: `--channel whatsapp --target <jid> --message-id <id> --emoji 👍`, plus `--dry-run` (prints payload, sends nothing) and `--json`.
- **Current config**: `~/.openclaw/openclaw.json` has top-level keys `["agents","gateway","session","tools","plugins","skills","wizard","meta","channels","bindings","auth"]` — there is **no** `hooks` key yet.

---

## File Structure

- **Create** `workspace/tools/hooks/ack-react/HOOK.md` — hook manifest (events, metadata).
- **Create** `workspace/tools/hooks/ack-react/handler.js` — ESM default-export handler. Two parts:
  - `decideReaction(event, groupId)` — **pure** function returning `{ react, target, messageId, reason }` (the filtering logic; fully unit-testable).
  - `default async (event)` — resolves `groupId` from config, calls `decideReaction`, and on `react:true` spawns the react CLI; swallows all errors.
- **Create** `workspace/tools/hooks/ack-react/handler.test.mjs` — `node:test` tests for `decideReaction` + a dry-run spawn check.
- **Modify** `~/.openclaw/openclaw.json` — add `hooks.internal.load.extraDirs` + `hooks.internal.enabled`.
- **Modify** `workspace/skills/job-scout/SKILL.md` — remove 👀/✅ instruction + react tool-row; extend rule #8.
- **Modify** `workspace/skills/job-scout/prompt-qa.md` — delete "Working on it" indicator section; add one-line note.
- **Modify** `/home/davidtobol2580/open_claw/CLAUDE.md` — document the new hook (operational map).

Git note: the repo root is `workspace/` (top-level `open_claw/` is **not** a git repo). Commits in Tasks below `cd` into `workspace/` and commit only paths under it. Files outside `workspace/` (`~/.openclaw/openclaw.json`, top-level `CLAUDE.md`, `docs/`) are **not** version-controlled here — they are edited but not committed; this is called out in the relevant steps.

---

## Task 1: Hook handler with tested filtering logic

**Files:**
- Create: `workspace/tools/hooks/ack-react/handler.js`
- Test: `workspace/tools/hooks/ack-react/handler.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `workspace/tools/hooks/ack-react/handler.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReaction } from "./handler.js";

const GROUP = "120363000000000000@g.us";

const baseEvent = (overrides = {}) => ({
  type: "message",
  action: "received",
  context: {
    channelId: "whatsapp",
    conversationId: GROUP,
    messageId: "3EB0ABC123",
    from: "+972500000000",
    ...overrides.context,
  },
  ...overrides,
});

test("reacts to a whatsapp group message with a messageId", () => {
  const d = decideReaction(baseEvent(), GROUP);
  assert.equal(d.react, true);
  assert.equal(d.target, GROUP);
  assert.equal(d.messageId, "3EB0ABC123");
});

test("ignores non-received message actions", () => {
  const d = decideReaction(baseEvent({ action: "sent" }), GROUP);
  assert.equal(d.react, false);
});

test("ignores non-whatsapp channels", () => {
  const d = decideReaction(baseEvent({ context: { channelId: "telegram" } }), GROUP);
  assert.equal(d.react, false);
});

test("ignores a different conversation (rule #1: only the configured group)", () => {
  const d = decideReaction(baseEvent({ context: { conversationId: "972500000000@s.whatsapp.net" } }), GROUP);
  assert.equal(d.react, false);
});

test("ignores when messageId is missing", () => {
  const d = decideReaction(baseEvent({ context: { messageId: undefined } }), GROUP);
  assert.equal(d.react, false);
});

test("ignores non-message event types", () => {
  const d = decideReaction({ type: "command", action: "received", context: {} }, GROUP);
  assert.equal(d.react, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools/hooks/ack-react && node --test`
Expected: FAIL — `Cannot find module './handler.js'` (or `decideReaction is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `workspace/tools/hooks/ack-react/handler.js`:

```js
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const LAUNCHER = "/home/davidtobol2580/open_claw/openclaw";
const CONFIG_PATH = "/home/davidtobol2580/open_claw/workspace/.config/job-scout.json";
const EMOJI = "👍";

/**
 * Pure decision function: should we react to this event, and with what target/message?
 * Only WhatsApp `message:received` events in the configured group, with a messageId.
 */
export function decideReaction(event, groupId) {
  const no = (reason) => ({ react: false, reason });
  if (!event || event.type !== "message") return no("not a message event");
  if (event.action !== "received") return no(`action=${event?.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  if (!groupId || ctx.conversationId !== groupId) return no(`conversation=${ctx.conversationId}`);
  if (!ctx.messageId) return no("no messageId");
  return { react: true, target: groupId, messageId: ctx.messageId, reason: "ok" };
}

async function resolveGroupId() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw)?.whatsapp?.group_id;
}

function runReact({ target, messageId }) {
  const args = ["message", "react", "--channel", "whatsapp",
    "--target", target, "--message-id", messageId, "--emoji", EMOJI];
  if (process.env.ACK_REACT_DRY_RUN) args.push("--dry-run");
  return new Promise((resolve) => {
    execFile(LAUNCHER, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}

/** Hook entry point — never throws; a failed 👍 must not block message processing. */
export default async function ackReact(event) {
  try {
    const groupId = await resolveGroupId();
    const decision = decideReaction(event, groupId);
    if (!decision.react) return;
    await runReact(decision);
  } catch {
    // swallow — acknowledgment is best-effort and must never break the pipeline
  }
}

export { runReact, resolveGroupId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools/hooks/ack-react && node --test`
Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/davidtobol2580/open_claw/workspace
git add tools/hooks/ack-react/handler.js tools/hooks/ack-react/handler.test.mjs
git commit -m "feat(hooks): ack-react handler — decideReaction + 👍 react (TDD)"
```

---

## Task 2: Dry-run spawn test (the react CLI is invoked correctly)

**Files:**
- Modify: `workspace/tools/hooks/ack-react/handler.test.mjs`

- [ ] **Step 1: Add the failing test**

Append to `handler.test.mjs`:

```js
import { runReact } from "./handler.js";

test("runReact invokes the launcher in dry-run without throwing", async () => {
  process.env.ACK_REACT_DRY_RUN = "1";
  const { err, stdout, stderr } = await runReact({ target: GROUP, messageId: "3EB0DRYRUN" });
  // dry-run must not error; CLI prints the payload it WOULD send
  assert.equal(err, null, `react CLI errored: ${stderr}`);
  assert.match(`${stdout}${stderr}`, /3EB0DRYRUN/);
});
```

- [ ] **Step 2: Run to verify it fails (or surfaces a real wiring problem)**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools/hooks/ack-react && ACK_REACT_DRY_RUN=1 node --test`
Expected: this test FAILS only if the launcher path/flags are wrong. If `--dry-run` output doesn't echo the message-id, inspect actual output with:
`/home/davidtobol2580/open_claw/openclaw message react --channel whatsapp --target "120363000000000000@g.us" --message-id "3EB0DRYRUN" --emoji 👍 --dry-run`
and adjust the assertion's regex to match whatever stable token the dry-run prints (e.g. the target jid or `react`). Keep the assertion on a token that is definitely present.

- [ ] **Step 3: Make it pass**

If the dry-run output doesn't contain the message-id, change the `assert.match` regex to a token confirmed present in the manual command's output (e.g. `/120363000000000000/`). No handler code change should be needed.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools/hooks/ack-react && node --test`
Expected: PASS — all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/davidtobol2580/open_claw/workspace
git add tools/hooks/ack-react/handler.test.mjs
git commit -m "test(hooks): ack-react dry-run spawn check"
```

---

## Task 3: Hook manifest (HOOK.md)

**Files:**
- Create: `workspace/tools/hooks/ack-react/HOOK.md`

- [ ] **Step 1: Write the manifest**

Create `workspace/tools/hooks/ack-react/HOOK.md` (frontmatter modeled on the bundled `command-logger/HOOK.md`):

```markdown
---
name: ack-react
description: "React 👍 to every inbound WhatsApp message in the Job Scout group"
metadata:
  {
    "openclaw":
      {
        "emoji": "👍",
        "events": ["message:received"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Ack-React Hook

Deterministically reacts 👍 to every inbound WhatsApp message in the configured
Job Scout group, the instant it is received — independent of the agent/LLM.

## Why

The LLM-driven acknowledgment (👀→✅) was unreliable: the conversational model skipped
reactions under load. This hook moves acknowledgment below the LLM so David always sees
that his message was received.

## What it does

1. Fires on the internal `message:received` event.
2. Filters: `channelId === "whatsapp"` AND `conversationId === whatsapp.group_id`
   (from `workspace/.config/job-scout.json`) AND `messageId` present.
   (Enforces hard rule #1 — only ever touches the configured group.)
3. Shells `openclaw message react … --emoji 👍`. Errors are swallowed (best-effort).

## Configuration

Registered via `hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` pointing at
`workspace/tools/hooks` (the parent dir of this pack). No other config needed.

## Disabling

```bash
openclaw hooks disable ack-react
```
```

- [ ] **Step 2: Verify the manifest parses (hook becomes discoverable after Task 4 config)**

No-op here; discovery is validated in Task 4. Just confirm the file exists:
Run: `ls workspace/tools/hooks/ack-react/`
Expected: `HOOK.md  handler.js  handler.test.mjs`

- [ ] **Step 3: Commit**

```bash
cd /home/davidtobol2580/open_claw/workspace
git add tools/hooks/ack-react/HOOK.md
git commit -m "feat(hooks): ack-react HOOK.md manifest"
```

---

## Task 4: Register the hook in config + verify discovery

**Files:**
- Modify: `~/.openclaw/openclaw.json` (NOT version-controlled — edit only)

- [ ] **Step 1: Back up the config**

Run: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-$(date +%Y%m%d-%H%M%S)`
Expected: a timestamped backup file exists (`ls ~/.openclaw/openclaw.json.bak-*`).

- [ ] **Step 2: Add the hooks block (merge, do not overwrite)**

Use a JSON-safe edit (jq) so existing keys are preserved:

```bash
TMP=$(mktemp)
jq '.hooks = (.hooks // {}) |
    .hooks.internal = (.hooks.internal // {}) |
    .hooks.internal.enabled = true |
    .hooks.internal.load = (.hooks.internal.load // {}) |
    .hooks.internal.load.extraDirs = ((.hooks.internal.load.extraDirs // []) + ["/home/davidtobol2580/open_claw/workspace/tools/hooks"] | unique)' \
  ~/.openclaw/openclaw.json > "$TMP" && mv "$TMP" ~/.openclaw/openclaw.json
```

- [ ] **Step 3: Validate JSON + show the new block**

Run: `jq '.hooks' ~/.openclaw/openclaw.json`
Expected: prints `{ "internal": { "enabled": true, "load": { "extraDirs": ["/home/davidtobol2580/open_claw/workspace/tools/hooks"] } } }` and exits 0 (valid JSON). If jq errors, restore from the backup and fix.

- [ ] **Step 4: Restart the gateway so it loads the new hook**

Run: `systemctl --user restart openclaw-gateway.service && sleep 5`

- [ ] **Step 5: Verify the hook is discovered and ready**

Run: `/home/davidtobol2580/open_claw/openclaw hooks list`
Expected: a row `ack-react` with status `✓ ready` (alongside the 5 bundled hooks).
If it is missing: check `openclaw hooks info ack-react` and the gateway journal
(`journalctl --user -u openclaw-gateway.service -n 50 --no-pager | grep -i hook`) for a manifest/parse error; fix `HOOK.md` and restart.

- [ ] **Step 6: No commit** (config is outside the git repo). Note in the run log that `~/.openclaw/openclaw.json` was edited and backed up.

---

## Task 5: Live end-to-end verification

**Files:** none (runtime check)

- [ ] **Step 1: Confirm the gateway is healthy and WhatsApp is connected**

Run: `cd /home/davidtobol2580/open_claw/workspace && node tools/sheet.mjs ping`
Expected: `{"ok":true,...}` (proves tooling path is alive).
Run: `journalctl --user -u openclaw-gateway.service -n 20 --no-pager | grep -i whatsapp`
Expected: recent WhatsApp activity, no `MissingAgentHarnessError`.

- [ ] **Step 2: Send a real test message** (requires the user)

Ask David to send any message (e.g. `בדיקה`) to the Job Scout group. Then:
Run: `journalctl --user -u openclaw-gateway.service --since "2 min ago" --no-pager | grep -iE 'reaction|ack-react'`
Expected: `Sent reaction "👍" -> message <id>` within ~1–2s of the inbound message.

- [ ] **Step 3: Confirm no regressions**

Run: `journalctl --user -u openclaw-gateway.service --since "2 min ago" --no-pager | grep -iE 'error|hook'`
Expected: Scotty's text reply still sent (`Sending message -> sha256:...`); NO hook errors; NO `MissingAgentHarnessError`. The 👍 appears on David's message in WhatsApp.

- [ ] **Step 4: Negative check (filter works)**

Confirm no 👍 is sent for non-group/non-whatsapp traffic by reviewing the same journal window — only the group message got a reaction. (No separate action needed; this is an observation.)

---

## Task 6: Remove dead LLM-reaction instructions from prompts

**Files:**
- Modify: `workspace/skills/job-scout/SKILL.md`
- Modify: `workspace/skills/job-scout/prompt-qa.md`

- [ ] **Step 1: SKILL.md — drop the 👀/✅ clause in "Mode routing"**

In `workspace/skills/job-scout/SKILL.md`, find in the *Mode routing* section item 2:
`Otherwise (any free-form text in WhatsApp) → load prompt-qa.md and engage in conversational Q&A. In this mode, react 👀 to David's incoming message as your FIRST action and ✅ as your LAST action (see prompt-qa.md "Working on it" indicator).`
Replace with:
`Otherwise (any free-form text in WhatsApp) → load prompt-qa.md and engage in conversational Q&A. (Acknowledgment — a 👍 on every inbound message — is handled automatically by the ack-react gateway hook; do NOT react from the prompt.)`

- [ ] **Step 2: SKILL.md — remove the "React (working/done indicator)" tool-table row**

Delete the entire table row beginning `| React (working/done indicator) |` (the row documenting `openclaw message react … 👀 … ✅`).

- [ ] **Step 3: prompt-qa.md — delete the "Working on it" indicator section**

In `workspace/skills/job-scout/prompt-qa.md`, delete the whole section that starts with the heading `## "Working on it" indicator (MANDATORY — do this every message)` through the end of its step 3 code block (the paragraph ending `… NOT the 09:00 cron scout.`). Replace the entire section with:

```markdown
## Acknowledgment (automatic — do nothing)

David's incoming messages are acknowledged with a 👍 reaction automatically by the
`ack-react` gateway hook, the instant they arrive. **Do NOT react from the prompt** and do
NOT run `openclaw message react` — that is now the hook's job. Just do the work and reply.
```

- [ ] **Step 4: Verify no stray 👀/✅ react instructions remain**

Run: `cd /home/davidtobol2580/open_claw/workspace && grep -rn "👀\|message react\|Working on it" skills/job-scout/`
Expected: no matches in `SKILL.md` / `prompt-qa.md` (the only remaining mentions, if any, should be none). If a stray reference remains, remove it.

- [ ] **Step 5: Commit**

```bash
cd /home/davidtobol2580/open_claw/workspace
git add skills/job-scout/SKILL.md skills/job-scout/prompt-qa.md
git commit -m "refactor(scout): drop LLM-driven 👀/✅ acks — hook owns acknowledgment now"
```

---

## Task 7: Extend rule #8 — Scotty states plainly what it cannot do from chat

**Files:**
- Modify: `workspace/skills/job-scout/SKILL.md`

- [ ] **Step 1: Append the honesty clause to rule #8**

In `workspace/skills/job-scout/SKILL.md`, at the end of *Hard rules* item 8 ("Controlled self-modification"), append:

```
 If David asks for something that requires a dev session — installing/changing gateway hooks, secrets, OAuth scopes, new channels, watchdog/infra — do NOT silently do nothing and do NOT pretend it's done. Reply plainly in Hebrew that you cannot wire that from chat and it needs a dev session (e.g. "זה דורש סשן פיתוח — אני לא יכול לחבר את זה מהצ'אט"), and say what David would do in a dev session. Self-edits of your own prompt/skill files still follow the plan-then-approve flow above (unchanged).
```

- [ ] **Step 2: Verify**

Run: `cd /home/davidtobol2580/open_claw/workspace && grep -n "דורש סשן פיתוח" skills/job-scout/SKILL.md`
Expected: one match inside rule #8.

- [ ] **Step 3: Commit**

```bash
cd /home/davidtobol2580/open_claw/workspace
git add skills/job-scout/SKILL.md
git commit -m "docs(scout): rule #8 — say plainly what needs a dev session"
```

---

## Task 8: Document the hook in the project map (CLAUDE.md)

**Files:**
- Modify: `/home/davidtobol2580/open_claw/CLAUDE.md` (NOT version-controlled — edit only)

- [ ] **Step 1: Add the hook to the layout + a short operational note**

In `/home/davidtobol2580/open_claw/CLAUDE.md`:
1. Under the `tools/` layout block, add a line:
   `│   └── hooks/ack-react/      # gateway hook: 👍 on every inbound group msg (deterministic ack)`
2. Add a short subsection after the "Agent runtime / capabilities" section:

```markdown
## Acknowledgment hook (ack-react) — verified 2026-05-27
Every inbound WhatsApp message in the Job Scout group gets an automatic 👍 via a gateway
hook (`workspace/tools/hooks/ack-react/`, event `message:received`), independent of the
LLM — this replaced the unreliable LLM-driven 👀/✅ indicator. Registered via
`hooks.internal.load.extraDirs` in `~/.openclaw/openclaw.json` (handler lives in workspace,
so it survives `openclaw` upgrades; if `openclaw hooks list` ever stops showing `ack-react`,
re-add the extraDirs entry and restart). Verify: `openclaw hooks list` shows `ack-react ✓ ready`;
send a group message → journal shows `Sent reaction "👍" -> message <id>`.
```

- [ ] **Step 2: Verify**

Run: `grep -n "ack-react" /home/davidtobol2580/open_claw/CLAUDE.md`
Expected: at least 2 matches (layout line + subsection).

- [ ] **Step 3: No commit** (top-level `CLAUDE.md` is outside the git repo). Note it was edited.

---

## Self-review notes (author)

- **Spec coverage:** hook handler (Task 1), config registration + upgrade-proofing (Task 4), group-only filter / rule #1 (Task 1 tests), prompt cleanup (Task 6), rule #8 honesty (Task 7), all four verification items (Tasks 2,4,5), risk re `--participant` (Task 2/5 confirm empirically). CLAUDE.md doc (Task 8). All spec sections mapped.
- **No placeholders:** every code/edit step shows exact content; the only adaptive step (Task 2 regex) gives the exact fallback command and token.
- **Type consistency:** `decideReaction(event, groupId)` returns `{react,target,messageId,reason}`; `runReact({target,messageId})`; default export `ackReact(event)`. Names consistent across Tasks 1–2.
- **Event key:** registered as `message:received` in `HOOK.md` AND guarded by `action==="received"` in `decideReaction` (defense in depth in case the loader registers on the bare `message` type).
