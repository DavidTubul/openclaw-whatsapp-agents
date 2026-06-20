# WhatsApp Session Hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Scotty's WhatsApp conversational session small and fresh so the broken native compactor never runs (no hallucination, no silent stalls), resetting by real size + a daily morning-quiet window, while preserving recent context across resets.

**Architecture:** A gateway hook mirrors every group message into an append-only chat-log + a lean `RECENT_CHAT.md` (continuity that survives resets). A periodic Node script (`session-hygiene.mjs`, run by a systemd user timer every 5 min) measures the active group transcript's byte size, and when it crosses a threshold — or once daily ≈07:30 Asia/Jerusalem — resets the session **only while idle**, using the proven restart-free primitive: archive the transcript, then `openclaw sessions cleanup --fix-missing --enforce`, then notify the group.

**Tech Stack:** Node 22 ESM (`node:test`, `node:fs`), bash/systemd user timers, the `openclaw` CLI. Mirrors existing `tools/hooks/ack-react` (hook) and `tools/gateway-watchdog.sh` (timer-driven maintenance) patterns.

**Verified facts this plan relies on (do not re-litigate):**
- Reset primitive (spike 2026-05-30): `mv <id>.jsonl <id>.jsonl.archived-*` then `openclaw sessions cleanup --fix-missing --enforce` drops the orphaned store entry; the **next turn auto-creates a fresh session with NO gateway restart**.
- Inbound/outbound event text lives in `event.context.content`; group id in `event.context.conversationId`; ts in `event.context.timestamp`; sender in `event.context.metadata`.
- Hooks register via `hooks.internal.load.extraDirs` → `workspace/tools/hooks` (already configured for `ack-react`); a new sibling pack is auto-discovered.
- `sessions.json.contextTokens` is the constant window size (NOT fullness). The real size signal is the transcript `.jsonl` byte size.
- Config path: `workspace/.config/job-scout.json`; group id at `.whatsapp.group_id` (`120363000000000000@g.us`). Session store: `~/.openclaw/agents/main/sessions/sessions.json`; group key `agent:main:whatsapp:group:120363000000000000@g.us`.

---

## File Structure

- Create `workspace/tools/hooks/chat-log/package.json` — `{"type":"module"}`.
- Create `workspace/tools/hooks/chat-log/handler.js` — pure fns (`decideLog`, `truncate`, `formatRecentMd`) + default hook (append record, regenerate `RECENT_CHAT.md`). Never throws.
- Create `workspace/tools/hooks/chat-log/handler.test.mjs` — unit tests for the pure fns.
- Create `workspace/tools/hooks/chat-log/HOOK.md` — manifest (events `message:received` + `message:sent`).
- Create `workspace/tools/session-hygiene.mjs` — pure fns (`resolveGroupSession`, `isIdle`, `isWithinWindow`, `decide`, `performReset`) + `main()`.
- Create `workspace/tools/session-hygiene.test.mjs` — unit tests for pure fns + reset ordering.
- Create `workspace/RECENT_CHAT.md` — placeholder so the read never fails before the first message.
- Modify `workspace/.config/job-scout.json` — add a `session_hygiene` config block.
- Modify `workspace/skills/job-scout/prompt-qa.md` — instruct the agent to read `RECENT_CHAT.md` first.
- Create `~/.config/systemd/user/openclaw-session-hygiene.service` — oneshot.
- Create `~/.config/systemd/user/openclaw-session-hygiene.timer` — every 5 min.
- Modify `CLAUDE.md` — document the mechanism + ops.

This repo is **not** a git repo (verified), so the "Commit" steps below are written as **checkpoints**: run the test, confirm green, then move on. If git is later initialized, convert them to real commits.

---

## Task 1: Config block for tunables

**Files:**
- Modify: `workspace/.config/job-scout.json`

- [ ] **Step 1: Add a `session_hygiene` block.** Open the JSON, add this top-level key (keep existing keys intact, valid JSON):

```json
"session_hygiene": {
  "enabled": true,
  "max_transcript_bytes": 1000000,
  "idle_secs": 90,
  "daily_reset": { "hour": 7, "minute": 30, "span_minutes": 10, "tz": "Asia/Jerusalem" },
  "recent_window": 30,
  "notify_on_reset": true
}
```

- [ ] **Step 2: Validate.** Run: `node -e "JSON.parse(require('fs').readFileSync('/home/davidtobol2580/open_claw/workspace/.config/job-scout.json','utf8')); console.log('valid')"`
Expected: `valid`. Also confirm `.whatsapp.group_id` is still present:
`node -e "console.log(require('/home/davidtobol2580/open_claw/workspace/.config/job-scout.json').whatsapp.group_id)"` → `120363000000000000@g.us`.

- [ ] **Step 3: Checkpoint.** Config is valid and unchanged except the new block.

---

## Task 2: chat-log hook — pure functions (TDD)

**Files:**
- Create: `workspace/tools/hooks/chat-log/package.json`
- Create: `workspace/tools/hooks/chat-log/handler.test.mjs`
- Create: `workspace/tools/hooks/chat-log/handler.js`

- [ ] **Step 1: package.json**

```json
{ "type": "module" }
```

- [ ] **Step 2: Write failing tests** — `handler.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLog, truncate, formatRecentMd } from "./handler.js";

const GROUP = "120363000000000000@g.us";
const ev = (action, over = {}) => ({
  type: "message", action,
  context: { channelId: "whatsapp", conversationId: GROUP, messageId: "M1",
    content: "שלום סקוטי", timestamp: "2026-05-30T10:00:00.000Z",
    metadata: { senderName: "David Tubul" }, ...over },
});

test("inbound in group → log as david with content", () => {
  const d = decideLog(ev("received"), GROUP);
  assert.deepEqual({ log: d.log, from: d.from, text: d.text }, { log: true, from: "david", text: "שלום סקוטי" });
});
test("outbound in group → log as scotty", () => {
  const d = decideLog(ev("sent", { content: "מצאתי 3 משרות" }), GROUP);
  assert.equal(d.log, true); assert.equal(d.from, "scotty"); assert.equal(d.text, "מצאתי 3 משרות");
});
test("other conversation → not logged (rule #1)", () => {
  assert.equal(decideLog(ev("received", { conversationId: "x@g.us" }), GROUP).log, false);
});
test("non-whatsapp channel → not logged", () => {
  assert.equal(decideLog(ev("received", { channelId: "telegram" }), GROUP).log, false);
});
test("empty/missing content → not logged", () => {
  assert.equal(decideLog(ev("received", { content: "" }), GROUP).log, false);
  assert.equal(decideLog(ev("received", { content: undefined }), GROUP).log, false);
});
test("non-message event → not logged", () => {
  assert.equal(decideLog({ type: "command", action: "received", context: {} }, GROUP).log, false);
});
test("truncate caps long text with ellipsis, keeps short text", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("a".repeat(20), 10), "aaaaaaaaaa…");
});
test("formatRecentMd renders last N, truncates scotty replies, newest last", () => {
  const recs = [
    { ts: "2026-05-30T09:00:00Z", from: "david", text: "היי" },
    { ts: "2026-05-30T09:01:00Z", from: "scotty", text: "y".repeat(800) },
    { ts: "2026-05-30T09:02:00Z", from: "david", text: "תודה" },
  ];
  const md = formatRecentMd(recs, 2, 300);
  assert.ok(md.includes("תודה"));            // newest kept
  assert.ok(!md.includes("היי"));            // oldest dropped (window=2)
  assert.ok(md.includes("…"));               // long scotty reply truncated
  assert.ok(md.indexOf("David") < md.indexOf("תודה")); // david label before its text
});
```

- [ ] **Step 3: Run — expect FAIL.** Run: `cd /home/davidtobol2580/open_claw/workspace/tools/hooks/chat-log && node --test`
Expected: FAIL (`handler.js` not found / exports undefined).

- [ ] **Step 4: Implement `handler.js`** (pure fns only for now; default export added in Task 3):

```js
import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG_PATH = "/home/davidtobol2580/open_claw/workspace/.config/job-scout.json";
const DATA_DIR = "/home/davidtobol2580/open_claw/workspace/data/chat-log";
const RECENT_MD = "/home/davidtobol2580/open_claw/workspace/RECENT_CHAT.md";

/** Should this event be logged, and as whom? Only WhatsApp messages in the configured group with text. */
export function decideLog(event, groupId) {
  const no = (reason) => ({ log: false, reason });
  if (!event || event.type !== "message") return no("not a message");
  if (event.action !== "received" && event.action !== "sent") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  if (!groupId || ctx.conversationId !== groupId) return no("other conversation");
  const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
  if (!text) return no("empty content");
  return {
    log: true,
    from: event.action === "received" ? "david" : "scotty",
    text,
    ts: typeof ctx.timestamp === "string" ? ctx.timestamp : undefined,
  };
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/** Render the last `n` records as Markdown, newest last; scotty replies capped at `maxReply` chars. */
export function formatRecentMd(records, n, maxReply = 600) {
  const tail = records.slice(-n);
  const lines = tail.map((r) => {
    const who = r.from === "david" ? "David" : "Scotty";
    const text = r.from === "scotty" ? truncate(r.text, maxReply) : r.text;
    const when = (r.ts || "").replace("T", " ").replace(/\..*$/, "");
    return `**${who}** (${when}): ${text}`;
  });
  return `# שיחות אחרונות (${tail.length})\n\n` + lines.join("\n\n") + "\n";
}

export { CONFIG_PATH, DATA_DIR, RECENT_MD };
```

- [ ] **Step 5: Run — expect PASS.** Run: `cd /home/davidtobol2580/open_claw/workspace/tools/hooks/chat-log && node --test`
Expected: all tests pass.

- [ ] **Step 6: Checkpoint.** Pure fns green.

---

## Task 3: chat-log hook — side effects + manifest

**Files:**
- Modify: `workspace/tools/hooks/chat-log/handler.js`
- Create: `workspace/tools/hooks/chat-log/HOOK.md`
- Create: `workspace/RECENT_CHAT.md`

- [ ] **Step 1: Add the default hook export to `handler.js`** (append at end):

```js
async function resolveGroupId() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"))?.whatsapp?.group_id;
}
async function resolveWindow() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"))?.session_hygiene?.recent_window ?? 30;
}
function recordFileFor(groupId) { return `${DATA_DIR}/${groupId}.jsonl`; }

/** Read back the last `window*4` records (enough lines to cover the window) for re-render. */
async function readTailRecords(file, maxLines) {
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

/** Hook entry — append the message to the full record, then regenerate RECENT_CHAT.md. Never throws. */
export default async function chatLog(event) {
  try {
    const groupId = await resolveGroupId();
    const d = decideLog(event, groupId);
    if (!d.log) return;
    const record = { ts: d.ts || new Date().toISOString(), from: d.from, text: d.text };
    const file = recordFileFor(groupId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n");
    const window = await resolveWindow();
    const recs = await readTailRecords(file, window * 2);
    await writeFile(RECENT_MD, formatRecentMd(recs, window));
  } catch {
    // best-effort: a chat-log failure must never block message processing
  }
}
```

- [ ] **Step 2: Create `HOOK.md`** (mirrors ack-react manifest shape; two events):

```markdown
---
name: chat-log
description: "Mirror every group message into an append-only chat-log + RECENT_CHAT.md (continuity across session resets)"
metadata:
  {
    "openclaw":
      {
        "events": ["message:received", "message:sent"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "OpenClaw workspace hook" }],
      },
  }
---

# Chat-Log Hook

Appends every inbound/outbound WhatsApp message in the Job Scout group to an append-only
record (`workspace/data/chat-log/<group>.jsonl`, never trimmed — full audit) and regenerates
a lean `workspace/RECENT_CHAT.md` (last N exchanges, Scotty replies truncated). Independent of
the LLM, so recent context survives session resets (see session-hygiene). Enforces hard rule #1
(only ever the configured group). Disable: `openclaw hooks disable chat-log`.
```

- [ ] **Step 3: Create placeholder `workspace/RECENT_CHAT.md`:**

```markdown
# שיחות אחרונות (0)

(עדיין אין היסטוריה — תתמלא עם ההודעה הראשונה.)
```

- [ ] **Step 4: Smoke-test the side effects with a synthetic event.** Run:

```bash
cd /home/davidtobol2580/open_claw/workspace/tools/hooks/chat-log
node -e '
import("./handler.js").then(async (m) => {
  const GROUP = require("/home/davidtobol2580/open_claw/workspace/.config/job-scout.json").whatsapp.group_id;
  await m.default({ type:"message", action:"received", context:{ channelId:"whatsapp", conversationId:GROUP, content:"בדיקת chat-log", timestamp:new Date().toISOString(), metadata:{} } });
  console.log("ran");
});'
tail -1 "/home/davidtobol2580/open_claw/workspace/data/chat-log/$(node -e "process.stdout.write(require('/home/davidtobol2580/open_claw/workspace/.config/job-scout.json').whatsapp.group_id)").jsonl"
grep -c "בדיקת chat-log" /home/davidtobol2580/open_claw/workspace/RECENT_CHAT.md
```
Expected: `ran`, the record line printed, and grep count `1` (RECENT_CHAT.md regenerated).

- [ ] **Step 5: Clean the smoke-test line** so it doesn't pollute the real log:
```bash
F="/home/davidtobol2580/open_claw/workspace/data/chat-log/$(node -e "process.stdout.write(require('/home/davidtobol2580/open_claw/workspace/.config/job-scout.json').whatsapp.group_id)").jsonl"
grep -v "בדיקת chat-log" "$F" > "$F.tmp" && mv "$F.tmp" "$F" || rm -f "$F"
```

- [ ] **Step 6: Checkpoint.** Hook writes record + RECENT_CHAT.md, never throws.

---

## Task 4: Register + verify the chat-log hook live

**Files:** none (config already points `extraDirs` at `workspace/tools/hooks`).

- [ ] **Step 1: Confirm discovery.** Run: `cd /home/davidtobol2580/open_claw && ./openclaw hooks list 2>&1 | grep -iE "chat-log|ack-react"`
Expected: both `chat-log` and `ack-react` listed as ready. If `chat-log` is absent, confirm `~/.openclaw/openclaw.json` `hooks.internal.load.extraDirs` includes `/home/davidtobol2580/open_claw/workspace/tools/hooks` (it already does for ack-react; the new pack is a sibling). Do **not** restart the gateway — hooks hot-load.

- [ ] **Step 2: Live verify (send David a real test is NOT allowed without his ok).** Instead, verify via the existing inbound flow passively: after the next real group message, confirm a line was appended:
```bash
wc -l "/home/davidtobol2580/open_claw/workspace/data/chat-log/$(node -e "process.stdout.write(require('/home/davidtobol2580/open_claw/workspace/.config/job-scout.json').whatsapp.group_id)").jsonl"
```
Expected: line count grows as messages arrive.

- [ ] **Step 3: Checkpoint.** Hook is registered and capturing.

---

## Task 5: session-hygiene — pure decision functions (TDD)

**Files:**
- Create: `workspace/tools/session-hygiene.test.mjs`
- Create: `workspace/tools/session-hygiene.mjs`

- [ ] **Step 1: Write failing tests** — `session-hygiene.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGroupSession, isIdle, isWithinWindow, decide } from "./session-hygiene.mjs";

const KEY = "agent:main:whatsapp:group:120363000000000000@g.us";

test("resolveGroupSession returns sid+file when present, null otherwise", () => {
  const store = { [KEY]: { sessionId: "s1", sessionFile: "/f/s1.jsonl" }, other: {} };
  assert.deepEqual(resolveGroupSession(store, KEY), { sessionId: "s1", sessionFile: "/f/s1.jsonl" });
  assert.equal(resolveGroupSession({}, KEY), null);
  assert.equal(resolveGroupSession({ [KEY]: { sessionId: "s1" } }, KEY), null); // no file
});

test("isIdle: true when transcript untouched longer than idleSecs", () => {
  const now = 1_000_000;
  assert.equal(isIdle(now - 200_000, now, 90), true);   // 200s ago
  assert.equal(isIdle(now - 10_000, now, 90), false);   // 10s ago → busy
});

test("isWithinWindow: minute-of-day inside [start, start+span)", () => {
  assert.equal(isWithinWindow(7, 32, 7, 30, 10), true);
  assert.equal(isWithinWindow(7, 30, 7, 30, 10), true);
  assert.equal(isWithinWindow(7, 40, 7, 30, 10), false); // exclusive end
  assert.equal(isWithinWindow(8, 0, 7, 30, 10), false);
});

test("decide: below thresholds → no reset", () => {
  const d = decide({ bytes: 500, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false });
  assert.deepEqual({ reset: d.reset, deferred: d.deferred, recordDaily: d.recordDaily }, { reset: false, deferred: false, recordDaily: false });
});

test("decide: size hit + idle → reset (not daily)", () => {
  const d = decide({ bytes: 2000, maxBytes: 1000, idle: true, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(d.reset, true); assert.equal(d.recordDaily, false);
});

test("decide: size hit but busy → deferred, no reset", () => {
  const d = decide({ bytes: 2000, maxBytes: 1000, idle: false, inDailyWindow: false, dailyAlreadyDone: false });
  assert.equal(d.reset, false); assert.equal(d.deferred, true);
});

test("decide: daily window + idle + not done → reset and recordDaily", () => {
  const d = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: false });
  assert.equal(d.reset, true); assert.equal(d.recordDaily, true);
});

test("decide: daily window but already done today → no reset", () => {
  const d = decide({ bytes: 10, maxBytes: 1000, idle: true, inDailyWindow: true, dailyAlreadyDone: true });
  assert.equal(d.reset, false);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test session-hygiene.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the pure fns in `session-hygiene.mjs`:**

```js
#!/usr/bin/env node
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";

const CONFIG = "/home/davidtobol2580/open_claw/workspace/.config/job-scout.json";
const STORE = "/home/davidtobol2580/.openclaw/agents/main/sessions/sessions.json";
const LAUNCHER = "/home/davidtobol2580/open_claw/openclaw";
const DAILY_MARKER = "/home/davidtobol2580/open_claw/workspace/data/session-hygiene-last-daily";
const KEY_PREFIX = "agent:main:whatsapp:group:";

export function resolveGroupSession(store, key) {
  const e = store?.[key];
  if (!e || !e.sessionId || !e.sessionFile) return null;
  return { sessionId: e.sessionId, sessionFile: e.sessionFile };
}
export function isIdle(mtimeMs, nowMs, idleSecs) {
  return (nowMs - mtimeMs) >= idleSecs * 1000;
}
export function isWithinWindow(hh, mm, winH, winM, spanMin) {
  const cur = hh * 60 + mm, start = winH * 60 + winM;
  return cur >= start && cur < start + spanMin;
}
export function decide({ bytes, maxBytes, idle, inDailyWindow, dailyAlreadyDone }) {
  const sizeHit = bytes >= maxBytes;
  const dailyHit = inDailyWindow && !dailyAlreadyDone;
  if (!sizeHit && !dailyHit) return { reset: false, deferred: false, recordDaily: false, reason: `ok (${bytes}B)` };
  if (!idle) return { reset: false, deferred: true, recordDaily: false, reason: "trigger met but session busy — deferred" };
  return { reset: true, deferred: false, recordDaily: dailyHit, reason: sizeHit ? `size ${bytes}>=${maxBytes}B` : "daily window" };
}

export { CONFIG, STORE, LAUNCHER, DAILY_MARKER, KEY_PREFIX };
```

- [ ] **Step 4: Run — expect PASS.** Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test session-hygiene.test.mjs`
Expected: all pass.

- [ ] **Step 5: Checkpoint.** Decision logic green.

---

## Task 6: session-hygiene — atomic reset (TDD with temp dir)

**Files:**
- Modify: `workspace/tools/session-hygiene.test.mjs`
- Modify: `workspace/tools/session-hygiene.mjs`

- [ ] **Step 1: Add failing tests for `performReset`** (append to the test file):

```js
import { performReset } from "./session-hygiene.mjs";
import { mkdtemp, writeFile as wf, readFile as rf, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("performReset: backup store, archive transcript, run cleanup — in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyg-"));
  const store = join(dir, "sessions.json");
  const tx = join(dir, "s1.jsonl");
  await wf(store, JSON.stringify({ k: { sessionId: "s1", sessionFile: tx } }));
  await wf(tx, "line1\nline2\n");
  const calls = [];
  const runCleanup = async () => { calls.push("cleanup"); return { code: 0 }; };
  const res = await performReset({ storePath: store, sessionFile: tx, ts: "20260530-070000", runCleanup });
  assert.equal(res.ok, true);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith("sessions.json.bak-")), "backup made");
  assert.ok(files.some((f) => f === "s1.jsonl.archived-20260530-070000"), "transcript archived");
  assert.ok(!files.includes("s1.jsonl"), "original transcript moved");
  assert.deepEqual(calls, ["cleanup"], "cleanup invoked after archive");
});

test("performReset: if archive fails, abort BEFORE cleanup (no broken state)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hyg-"));
  const store = join(dir, "sessions.json");
  await wf(store, JSON.stringify({ k: {} }));
  let cleanupCalled = false;
  const runCleanup = async () => { cleanupCalled = true; return { code: 0 }; };
  // sessionFile points at a non-existent path → rename throws
  const res = await performReset({ storePath: store, sessionFile: join(dir, "missing.jsonl"), ts: "x", runCleanup });
  assert.equal(res.ok, false);
  assert.equal(cleanupCalled, false, "cleanup NOT called when archive fails");
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test session-hygiene.test.mjs`
Expected: FAIL (`performReset` undefined).

- [ ] **Step 3: Implement `performReset` in `session-hygiene.mjs`** (append before the export line; add `performReset` to exports):

```js
/**
 * Atomic, restart-free reset: backup store → archive transcript → prune orphan via openclaw.
 * Order matters: the entry is pruned by openclaw's own command AFTER the file is archived, so the
 * missing-file-but-entry-kept state (2026-05-28 root cause) can never persist. Aborts on any error
 * before cleanup, leaving an intact (if large) session rather than a broken one.
 */
export async function performReset({ storePath, sessionFile, ts, runCleanup }) {
  try {
    const backup = await readFile(storePath, "utf8");
    await writeFile(`${storePath}.bak-${ts}`, backup);
    await rename(sessionFile, `${sessionFile}.archived-${ts}`); // throws if missing → abort, no cleanup
  } catch (e) {
    return { ok: false, stage: "archive", error: String(e?.message || e) };
  }
  const r = await runCleanup();
  return r?.code === 0 ? { ok: true } : { ok: false, stage: "cleanup", error: `cleanup code ${r?.code}` };
}
```

Update the trailing export to include it:
```js
export { CONFIG, STORE, LAUNCHER, DAILY_MARKER, KEY_PREFIX };
```
(performReset is already exported via `export async function`.)

- [ ] **Step 4: Run — expect PASS.** Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test session-hygiene.test.mjs`
Expected: all pass.

- [ ] **Step 5: Checkpoint.** Reset ordering verified, including the abort-on-failure safety.

---

## Task 7: session-hygiene — `main()` orchestration

**Files:**
- Modify: `workspace/tools/session-hygiene.mjs`

- [ ] **Step 1: Add `main()` and the CLI entry** (append at end, after exports):

```js
function jerusalemParts(now, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}
function tsStamp(now, tz) {
  const { date, hh, mm } = jerusalemParts(now, tz);
  return `${date.replace(/-/g, "")}-${String(hh).padStart(2,"0")}${String(mm).padStart(2,"0")}00`;
}
function runCleanupReal() {
  return new Promise((resolve) => {
    execFile(LAUNCHER, ["sessions", "cleanup", "--fix-missing", "--enforce"],
      { timeout: 60000 }, (err) => resolve({ code: err ? (err.code ?? 1) : 0 }));
  });
}
function sendNotify(groupId, msg) {
  return new Promise((resolve) => {
    execFile(LAUNCHER, ["message", "send", "--channel", "whatsapp", "--target", groupId, "--message", msg],
      { timeout: 20000 }, () => resolve());
  });
}
function log(m) { console.log(`[session-hygiene ${new Date().toISOString()}] ${m}`); }

export async function main({ now = new Date(), dryRun = false } = {}) {
  const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  const h = cfg.session_hygiene || {};
  if (h.enabled === false) { log("disabled — skipping"); return; }
  const groupId = cfg?.whatsapp?.group_id;
  if (!groupId) { log("no group_id — abort (rule #1)"); return; }       // never guess a target
  const key = KEY_PREFIX + groupId;

  const store = JSON.parse(await readFile(STORE, "utf8"));
  const sess = resolveGroupSession(store, key);
  if (!sess) { log("no active group session — nothing to do"); return; }

  let st; try { st = await stat(sess.sessionFile); }
  catch { log(`transcript missing (${sess.sessionFile}) — leaving for openclaw cleanup`); return; }
  const bytes = st.size;
  const nowMs = now.getTime();
  const idle = isIdle(st.mtimeMs, nowMs, h.idle_secs ?? 90);

  const dr = h.daily_reset || {};
  const tz = dr.tz || "Asia/Jerusalem";
  const jp = jerusalemParts(now, tz);
  const inDailyWindow = isWithinWindow(jp.hh, jp.mm, dr.hour ?? 7, dr.minute ?? 30, dr.span_minutes ?? 10);
  let lastDaily = ""; try { lastDaily = (await readFile(DAILY_MARKER, "utf8")).trim(); } catch {}
  const dailyAlreadyDone = lastDaily === jp.date;

  const d = decide({ bytes, maxBytes: h.max_transcript_bytes ?? 1_000_000, idle, inDailyWindow, dailyAlreadyDone });
  log(`size=${bytes}B idle=${idle} dailyWindow=${inDailyWindow} dailyDone=${dailyAlreadyDone} → ${d.reset ? "RESET" : (d.deferred ? "DEFER" : "noop")} (${d.reason})`);
  if (!d.reset) return;
  if (dryRun) { log("dry-run — not resetting"); return; }

  const ts = tsStamp(now, tz);
  const res = await performReset({ storePath: STORE, sessionFile: sess.sessionFile, ts, runCleanup: runCleanupReal });
  if (!res.ok) { log(`RESET FAILED at ${res.stage}: ${res.error} — session left intact`); return; }
  if (d.recordDaily) await writeFile(DAILY_MARKER, jp.date);
  log("reset OK");
  if (h.notify_on_reset !== false) {
    await sendNotify(groupId, "התחלתי שיחה חדשה כדי להישאר חד 🙂 כל המעקב והמשרות שמורים — אפשר להמשיך כרגיל.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main({ dryRun: process.argv.includes("--dry-run") }).catch((e) => { log(`fatal: ${e?.message || e}`); process.exit(1); });
}
```

- [ ] **Step 2: Dry-run against the LIVE store (no mutation).** Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node session-hygiene.mjs --dry-run`
Expected: a log line like `size=<N>B idle=<bool> dailyWindow=false dailyDone=false → noop (ok (<N>B))` (current transcript is ~10KB, far below 1MB → noop). No files changed.

- [ ] **Step 3: Confirm no mutation.** Run: `ls /home/davidtobol2580/.openclaw/agents/main/sessions/ | grep -c "archived-$(date +%Y%m%d)"` — should reflect only pre-existing archives, none newly created by the dry-run.

- [ ] **Step 4: Checkpoint.** main() reads live state and correctly decides "noop" today.

---

## Task 8: Forced end-to-end reset test (real, on a throwaway key)

Validates the real `runCleanupReal` + `performReset` path end-to-end without touching the group.

- [ ] **Step 1: Create a throwaway session and point a temp config at it.** Run:

```bash
cd /home/davidtobol2580/open_claw
./openclaw agent --session-key diagnostic:hyg-e2e -m "seed" >/dev/null 2>&1
SID=$(node -e "const s=require('/home/davidtobol2580/.openclaw/agents/main/sessions/sessions.json');console.log(s['agent:main:diagnostic:hyg-e2e'].sessionId)")
echo "throwaway sid=$SID"
```

- [ ] **Step 2: Inline reset on that exact transcript** (reuses the real primitive; does NOT use the group key):

```bash
cd /home/davidtobol2580/open_claw/workspace/tools
node -e '
import("./session-hygiene.mjs").then(async (m) => {
  const SES="/home/davidtobol2580/.openclaw/agents/main/sessions";
  const store=`${SES}/sessions.json`;
  const sid=process.argv[1];
  const r=await m.performReset({ storePath: store, sessionFile: `${SES}/${sid}.jsonl`, ts:"e2e", runCleanup: () => new Promise(res=>require("child_process").execFile("/home/davidtobol2580/open_claw/openclaw",["sessions","cleanup","--fix-missing","--enforce"],{timeout:60000},(e)=>res({code:e?1:0}))) });
  console.log("reset:", JSON.stringify(r));
});' "$SID"
node -e "const s=require('/home/davidtobol2580/.openclaw/agents/main/sessions/sessions.json');console.log('entry present after reset:', 'agent:main:diagnostic:hyg-e2e' in s)"
```
Expected: `reset: {"ok":true}` and `entry present after reset: false`.

- [ ] **Step 3: Confirm fresh session on next turn (no restart).** Run:
```bash
cd /home/davidtobol2580/open_claw
./openclaw agent --session-key diagnostic:hyg-e2e -m "after reset" >/dev/null 2>&1
node -e "const s=require('/home/davidtobol2580/.openclaw/agents/main/sessions/sessions.json');console.log('new sid:', s['agent:main:diagnostic:hyg-e2e'].sessionId)"
```
Expected: a **new** sessionId, different from Step 1's `$SID`.

- [ ] **Step 4: Cleanup throwaway artifacts.** Run:
```bash
cd /home/davidtobol2580/open_claw
SES=/home/davidtobol2580/.openclaw/agents/main/sessions
rm -f "$SES"/*.archived-e2e
NEW=$(node -e "const s=require('$SES/sessions.json');const e=s['agent:main:diagnostic:hyg-e2e'];process.stdout.write(e?e.sessionId:'')")
[ -n "$NEW" ] && rm -f "$SES/$NEW.jsonl"
node -e "const fs=require('fs');const p='$SES/sessions.json';const s=JSON.parse(fs.readFileSync(p,'utf8'));delete s['agent:main:diagnostic:hyg-e2e'];fs.writeFileSync(p,JSON.stringify(s));console.log('throwaway entry removed')"
ls "$SES"/sessions.json.bak-e2e >/dev/null 2>&1 && rm -f "$SES"/sessions.json.bak-e2e
```
Expected: `throwaway entry removed`; no e2e artifacts remain.

- [ ] **Step 5: Verify the group session is untouched.** Run:
```bash
node -e "const s=require('/home/davidtobol2580/.openclaw/agents/main/sessions/sessions.json');const g=s['agent:main:whatsapp:group:120363000000000000@g.us'];console.log('group intact:', !!g, g&&g.sessionId)"
```
Expected: `group intact: true <sid>`.

- [ ] **Step 6: Checkpoint.** Full reset primitive proven through our own code path; group untouched.

---

## Task 9: systemd timer + service

**Files:**
- Create: `~/.config/systemd/user/openclaw-session-hygiene.service`
- Create: `~/.config/systemd/user/openclaw-session-hygiene.timer`

- [ ] **Step 1: Create the service** `openclaw-session-hygiene.service`:

```ini
[Unit]
Description=OpenClaw WhatsApp session hygiene (size/daily reset, idle-gated, restart-free)

[Service]
Type=oneshot
TimeoutStartSec=120
ExecStart=/home/davidtobol2580/.nvm/versions/node/v22.22.3/bin/node /home/davidtobol2580/open_claw/workspace/tools/session-hygiene.mjs
```
(Confirm the node path: `which node` under nvm 22 = `/home/davidtobol2580/.nvm/versions/node/v22.22.3/bin/node`. If different, use that path.)

- [ ] **Step 2: Create the timer** `openclaw-session-hygiene.timer`:

```ini
[Unit]
Description=Run OpenClaw session hygiene every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=300s
AccuracySec=15s

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Enable + start the timer.** Run:
```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-session-hygiene.timer
systemctl --user list-timers openclaw-session-hygiene.timer --no-pager
```
Expected: timer listed with a NEXT time ~5 min out.

- [ ] **Step 4: Trigger one run now + read its log.** Run:
```bash
systemctl --user start openclaw-session-hygiene.service
journalctl --user -u openclaw-session-hygiene.service --since "2 min ago" --no-pager | tail
```
Expected: a `[session-hygiene …] size=…B … → noop` line, no errors.

- [ ] **Step 5: Checkpoint.** Timer runs the script on schedule; today it correctly no-ops.

---

## Task 10: RECENT_CHAT.md injection into the conversational prompt

**Files:**
- Modify: `workspace/skills/job-scout/prompt-qa.md`

- [ ] **Step 1: Add a "Recent context" instruction near the top of `prompt-qa.md`**, right after the "Acknowledgment (automatic — do nothing)" section. Insert:

```markdown
## Recent context (read FIRST — continuity across session resets)

Your session is periodically reset to stay fresh, so do NOT assume you remember earlier turns.
**Before replying, read `/home/davidtobol2580/open_claw/workspace/RECENT_CHAT.md`** — it holds the
last ~30 exchanges with David (maintained by the chat-log hook, survives resets). Use it for
continuity ("what were we just talking about"). The Google Sheet remains the source of truth for
job/application data; RECENT_CHAT.md is only for conversational context.
```

- [ ] **Step 2: Confirm the file is referenced and exists.** Run:
```bash
grep -q "RECENT_CHAT.md" /home/davidtobol2580/open_claw/workspace/skills/job-scout/prompt-qa.md && echo "referenced"
ls -la /home/davidtobol2580/open_claw/workspace/RECENT_CHAT.md
```
Expected: `referenced` and the file exists.

- [ ] **Step 3: Checkpoint.** Skill edits hot-reload (no restart). Next conversational turn will read RECENT_CHAT.md.

---

## Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a new section to `CLAUDE.md`** (after the watchdog/reliability sections):

```markdown
## Session hygiene — keeps the conversational session small (added 2026-05-30)
The WhatsApp group session is kept small so OpenClaw's (broken) native compactor never runs —
the real fix for the silent-bot/hallucination failure. Mechanism (`workspace/tools/session-hygiene.mjs`,
run every 5 min by `openclaw-session-hygiene.timer`):
- **Metric:** byte size of the active group transcript `.jsonl` (NOT `contextTokens`, which is the
  constant 1M window size). Reset threshold default 1,000,000 bytes (`session_hygiene` block in
  `workspace/.config/job-scout.json`).
- **Triggers:** size ≥ threshold (any time) OR a daily ≈07:30 Asia/Jerusalem window — both
  **idle-gated** (transcript mtime older than `idle_secs`, default 90s) so a reset never interrupts
  a live chat. Daily reset de-duped via `workspace/data/session-hygiene-last-daily`.
- **Reset primitive (restart-free, verified):** `mv <id>.jsonl <id>.jsonl.archived-*` then
  `openclaw sessions cleanup --fix-missing --enforce`; the next inbound message auto-creates a fresh
  session. NO gateway restart (restarts risk the harness-deregistration failure). Aborts safely if
  archive/cleanup fails (session left intact).
- **Continuity:** the `chat-log` gateway hook (`workspace/tools/hooks/chat-log/`) mirrors every group
  message to an append-only record (`workspace/data/chat-log/<group>.jsonl`, full text, never trimmed)
  and regenerates `workspace/RECENT_CHAT.md` (last ~30, injected via prompt-qa.md). Job data lives in
  the Sheet, untouched by resets.
- **Notify:** a short Hebrew message to the group on each reset (toggle `notify_on_reset`).
Verify: `node workspace/tools/session-hygiene.mjs --dry-run`; `systemctl --user list-timers openclaw-session-hygiene.timer`.
```

- [ ] **Step 2: Checkpoint.** Mechanism documented for future sessions.

---

## Self-Review (run after all tasks)

- **Spec coverage:** Layer 1 (size+daily metric) → Tasks 5,7; Layer 2 (atomic restart-free reset) → Tasks 6,7,8; Layer 3 (chat-log + RECENT_CHAT.md) → Tasks 2,3,4,10; Layer 4 (notify + watchdog net) → Task 7 (notify) + existing watchdog (unchanged); reduce-growth trim → explicitly deferred (separate plan).
- **Idle gate, daily de-dup, rule #1 (group-only target), archive-not-delete** — all present.
- **No placeholders**; all code shown; types consistent (`decide`/`performReset`/`isIdle`/`resolveGroupSession` signatures match across tasks).
- **Final health check (per David's request):** after Task 11, run the comprehensive "nothing broke" check — gateway health, harness ping, sheet ping, hooks list, sessions.json validity + group intact, timer scheduled, dry-run noop. (Covered in the execution wrap-up, not a code task.)
