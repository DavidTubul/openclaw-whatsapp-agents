# Digit Gmail Mirror + Unreplied Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local Markdown mirror of the company Gmail for digit (backfill + UID-incremental), with a twice-daily OpenClaw cron that posts new-unreplied-mail summaries to the DY WhatsApp group.

**Architecture:** A workspace tool (`gmail-sync.mjs`, IMAP via `imapflow`, App Password auth) mirrors `[Gmail]/All Mail` into `data/mail/messages/*.md` + `INDEX.md`, tracks state by UID, and emits `pending-attention.json` for new threads whose last message is inbound. Digit reads INDEX-first (context discipline). A native OpenClaw cron (isolated run, announce→DY group) runs the sync and summarizes pending mail.

**Tech Stack:** Node 22 ESM, `imapflow`, `node --test`, OpenClaw cron. Spec: `docs/superpowers/specs/2026-07-15-digit-gmail-sync-design.md` (read it first).

## Global Constraints

- All paths below are relative to `/home/davidtobol2580/open_claw/workspace-realestate/` unless absolute.
- **Read-only mailbox**: fetch with `BODY.PEEK` semantics only (imapflow `fetch` with `source: true` does NOT set \Seen when the connection avoids STORE; never call `messageFlagsAdd/Set`, `store`, `append`, `delete`). No code path may write to Gmail.
- Node binary for systemd/cron contexts: `/home/davidtobol2580/.nvm/versions/node/v22.22.3/bin/node`.
- Hebrew for any user-facing WhatsApp text; English for code/comments.
- Secrets file `~/.openclaw/secrets/gmail-digit.env`, chmod 600. Never commit secrets. Never touch `~/.openclaw/credentials/whatsapp/`.
- DY group jid: `1203630000000000DY@g.us`. Consultation group jid: `1203630000000000CN@g.us`.
- Do NOT edit `~/.openclaw/openclaw.json` — no routing/binding changes are needed for this feature.
- Commit after every task (repo `/home/davidtobol2580/open_claw`, currently at `f1b11ac`).

---

### Task 1: Dependencies + secrets scaffolding

**Files:**
- Modify: `tools/package.json` (add `imapflow` dep)
- Create: `/home/davidtobol2580/.openclaw/secrets/gmail-digit.env` (placeholder values)

**Interfaces:**
- Produces: `import { ImapFlow } from 'imapflow'` resolvable from `tools/`; env file at the fixed path with keys `GMAIL_USER`, `GMAIL_APP_PASSWORD`.

- [ ] **Step 1: Install imapflow in the workspace tools dir**

```bash
cd /home/davidtobol2580/open_claw/workspace-realestate/tools && npm install imapflow@^1
```
Expected: `package.json` gains `"dependencies": { "imapflow": "^1...." }`, `node_modules/` appears (it is gitignored — check `git status` shows only `package.json`/`package-lock.json`).

- [ ] **Step 2: Create the secrets file with placeholders**

```bash
install -m 600 /dev/null ~/.openclaw/secrets/gmail-digit.env
cat > ~/.openclaw/secrets/gmail-digit.env <<'EOF'
GMAIL_USER=REPLACE_ME@gmail.com
GMAIL_APP_PASSWORD=REPLACE_ME
EOF
```
David fills real values later (Task 6). Verify: `stat -c %a ~/.openclaw/secrets/gmail-digit.env` → `600`.

- [ ] **Step 3: Commit**

```bash
cd /home/davidtobol2580/open_claw && git add workspace-realestate/tools/package.json workspace-realestate/tools/package-lock.json && git commit -m "feat(digit): add imapflow dep for gmail-sync"
```

---

### Task 2: Pure mail logic — `tools/lib/mail-core.mjs` (TDD)

**Files:**
- Create: `tools/lib/mail-core.mjs`
- Test: `tools/gmail-sync.test.mjs`

**Interfaces:**
- Produces (consumed by Task 3):
  - `decodeMimeBody(rawSource: Buffer|string): string` — plain text from RFC822 (copy the proven implementation from `workspace-jobscout/tools/gmail-search.mjs` lines ~42–66: `decodeQP` + MIME-part walk + HTML strip; do not import across workspaces).
  - `renderMessageMd(m): string` where `m = {uid, threadId, from, fromName, to, cc, subject, date(ISO), attachments:[{name,size}], text}` → Markdown with YAML frontmatter (keys: `uid, thread, from, to, cc, subject, date, attachments`) then body text.
  - `messageFileName(m): string` → `YYYY-MM-DD--<uid>.md` (date from `m.date`).
  - `computePending(threads, accountEmail, prevLastUid): Array<{file,from,subject,date}>` — `threads` is `Map<threadId, m[]>` over ALL mirrored messages; a thread is pending when its newest-by-date message has `from !== accountEmail` (case-insensitive); include it ONLY if that newest message has `uid > prevLastUid` (alert-once rule).
  - `renderIndex(messages, accountEmail): string` — newest-first lines: `| date | from | subject | replied ✓/✗ | messages/<file> |` where replied=✓ iff the message's thread's newest message is from `accountEmail` OR the message itself is outbound.
  - `loadState(path)/saveState(path, {uidValidity,lastUid,lastSyncTs})` — JSON round-trip, `loadState` returns `null` when missing/corrupt.

- [ ] **Step 1: Write failing tests** — `tools/gmail-sync.test.mjs` with `node:test` + `node:assert/strict`, fixtures inline. Cover: (a) decodeQP/base64/html-fallback MIME decode; (b) frontmatter render escapes `"` in subject and includes all keys; (c) `messageFileName({date:'2026-07-15T10:00:00Z',uid:42})` → `2026-07-15--42.md`; (d) `computePending`: thread ending inbound+new → included; ending outbound → excluded; ending inbound but `uid<=prevLastUid` → excluded (alert-once); (e) `renderIndex` newest-first + replied flag both ways; (f) state round-trip + missing-file → null.

```js
// example shape — write the full 8–10 test cases in this style
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePending } from './lib/mail-core.mjs';

test('thread whose last message is inbound and new → pending', () => {
  const threads = new Map([['t1', [
    { uid: 1, from: 'us@gmail.com', date: '2026-07-14T08:00:00Z', subject: 'q', file: 'a.md' },
    { uid: 9, from: 'them@x.com',  date: '2026-07-15T09:00:00Z', subject: 'q', file: 'b.md' },
  ]]]);
  assert.deepEqual(computePending(threads, 'us@gmail.com', 5),
    [{ file: 'b.md', from: 'them@x.com', subject: 'q', date: '2026-07-15T09:00:00Z' }]);
});
```

- [ ] **Step 2: Run to verify failure** — `cd workspace-realestate && node --test tools/gmail-sync.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement `tools/lib/mail-core.mjs`** — pure functions only, no network/fs except in load/saveState (use `readFileSync`/`writeFileSync` with try/catch). Copy `decodeQP`+`decodeMimeBody` verbatim from `workspace-jobscout/tools/gmail-search.mjs` (they are battle-tested; keep the attribution comment `// copied from workspace-jobscout gmail-search.mjs — workspaces stay isolated`).

- [ ] **Step 4: Run tests to green** — `node --test tools/gmail-sync.test.mjs` → all PASS. Also run the existing suite: `node --test tools/drive-sync.test.mjs` still passes.

- [ ] **Step 5: Commit** — `git add workspace-realestate/tools/lib/mail-core.mjs workspace-realestate/tools/gmail-sync.test.mjs && git commit -m "feat(digit): mail-core pure logic + tests"`

---

### Task 3: The sync CLI — `tools/gmail-sync.mjs`

**Files:**
- Create: `tools/gmail-sync.mjs`
- Modify: `tools/gmail-sync.test.mjs` (add arg/env-parse tests if any pure helpers are added)

**Interfaces:**
- Consumes: everything from `mail-core.mjs` (Task 2 signatures).
- Produces: CLI `node tools/gmail-sync.mjs [--dry-run] [--verbose] [--full]`; writes `data/mail/messages/*.md`, `data/mail/INDEX.md`, `data/mail/state.json`, `data/mail/pending-attention.json`; exit 0 ok / 2 config error / 1 sync error (JSON on stderr).

- [ ] **Step 1: Implement** (model on `gmail-search.mjs` connection code + `drive-sync.mjs` CLI conventions):

```js
#!/usr/bin/env node
// Gmail → local Markdown mirror for digit. Read-only (PEEK; no STORE/APPEND ever).
// Auth: GMAIL_USER/GMAIL_APP_PASSWORD from env, falling back to ~/.openclaw/secrets/gmail-digit.env.
import { ImapFlow } from 'imapflow';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMimeBody, renderMessageMd, messageFileName, computePending, renderIndex, loadState, saveState } from './lib/mail-core.mjs';

const WS = dirname(dirname(fileURLToPath(import.meta.url)));          // workspace root
const MAIL = join(WS, 'data', 'mail');
const args = new Set(process.argv.slice(2));
const V = args.has('--verbose'), DRY = args.has('--dry-run');

function loadEnvFile(p) {                                              // minimal .env parser
  try { for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  } } catch {}
}
loadEnvFile(join(process.env.HOME, '.openclaw', 'secrets', 'gmail-digit.env'));
const USER = process.env.GMAIL_USER, PASS = process.env.GMAIL_APP_PASSWORD;
if (!USER || !PASS || USER.startsWith('REPLACE')) { console.error(JSON.stringify({ error: 'gmail creds missing (see secrets/gmail-digit.env)' })); process.exit(2); }

mkdirSync(join(MAIL, 'messages'), { recursive: true });
const statePath = join(MAIL, 'state.json');
let state = args.has('--full') ? null : loadState(statePath);

const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
try {
  await client.connect();
  const lock = await client.getMailboxLock('[Gmail]/All Mail');
  try {
    const box = client.mailbox;
    if (state && state.uidValidity !== box.uidValidity) { if (V) console.error('[gmail-sync] UIDVALIDITY changed → full re-mirror'); state = null; }
    const startUid = state ? state.lastUid + 1 : 1;
    const newMsgs = [];
    for await (const msg of client.fetch(`${startUid}:*`, { envelope: true, internalDate: true, uid: true, source: true, bodyStructure: true }, { uid: true })) {
      if (state && msg.uid <= state.lastUid) continue;                 // Gmail returns last msg for empty ranges
      const atts = [];
      (function walk(n) { if (!n) return; if (n.disposition === 'attachment') atts.push({ name: n.dispositionParameters?.filename || n.parameters?.name || 'unnamed', size: n.size || 0 }); (n.childNodes || []).forEach(walk); })(msg.bodyStructure);
      newMsgs.push({ uid: msg.uid, threadId: String(msg.threadId || msg.emailId || msg.uid), from: msg.envelope.from?.[0]?.address || '', fromName: msg.envelope.from?.[0]?.name || '', to: (msg.envelope.to || []).map(a => a.address).join(', '), cc: (msg.envelope.cc || []).map(a => a.address).join(', '), subject: msg.envelope.subject || '(no subject)', date: msg.internalDate?.toISOString() || new Date(0).toISOString(), attachments: atts, text: decodeMimeBody(msg.source) });
    }
    if (V) console.error(`[gmail-sync] ${newMsgs.length} new message(s) (from uid ${startUid})`);
    if (!DRY) {
      for (const m of newMsgs) writeFileSync(join(MAIL, 'messages', messageFileName(m)), renderMessageMd(m));
      // rebuild thread map over ALL mirrored mail (read frontmatter of every messages/*.md via mail-core helper or keep a messages.jsonl sidecar — implementer's choice; keep it in mail-core with a test)
      const all = loadAllMessages(join(MAIL, 'messages'));             // implement in mail-core: parse frontmatter back (add test)
      const threads = groupByThread(all);                              // implement in mail-core (add test)
      writeFileSync(join(MAIL, 'INDEX.md'), renderIndex(all, USER));
      writeFileSync(join(MAIL, 'pending-attention.json'), JSON.stringify(computePending(threads, USER, state ? state.lastUid : 0), null, 2));
      const maxUid = newMsgs.reduce((a, m) => Math.max(a, m.uid), state ? state.lastUid : 0);
      saveState(statePath, { uidValidity: box.uidValidity, lastUid: maxUid, lastSyncTs: new Date().toISOString() });
    }
  } finally { lock.release(); }
} catch (e) { console.error(JSON.stringify({ error: String(e?.message || e) })); process.exitCode = 1; }
finally { await client.logout().catch(() => {}); }
```
Notes for the implementer: `imapflow` exposes Gmail's `X-GM-THRID` as `msg.threadId` when the server advertises it — verify on first real run (`--verbose`); the `1:*` backfill on first run IS the full-mailbox mirror. Add `loadAllMessages`/`groupByThread` to `mail-core.mjs` **with tests first** (frontmatter parse round-trip of `renderMessageMd` output).

- [ ] **Step 2: Extend tests + run** — add round-trip tests (`renderMessageMd` → `loadAllMessages` parses back same fields; `groupByThread` groups by `thread`). `node --test tools/gmail-sync.test.mjs` → PASS.

- [ ] **Step 3: Dry-run against missing creds** — `node tools/gmail-sync.mjs --dry-run` with placeholder env → exits 2 with the JSON error (proves the guard).

- [ ] **Step 4: Commit** — `git commit -m "feat(digit): gmail-sync CLI (backfill + UID-incremental mirror)"`

---

### Task 4: Digit-side context discipline — AGENTS.md + router

**Files:**
- Modify: `AGENTS.md` (workspace root — always injected)
- Modify: `skills/realestate-advisor/router.md`

- [ ] **Step 1: Add to `AGENTS.md`** (after the existing group-notes/chat-log section, matching its tone):

```markdown
## 📧 המיילים של החברה (data/mail/)
תיבת ה-Gmail של דוד ויהונתן משוקפת מקומית. כשנשאלת על מיילים:
1. הרץ קודם `node tools/gmail-sync.mjs` (שניות — מוריד רק חדשים) כדי להיות מעודכן לרגע זה.
2. פתח את `data/mail/INDEX.md` (שורה למייל: תאריך | מאת | נושא | נענה | קובץ) ו-grep בו.
3. פתח **רק** את קבצי `data/mail/messages/*.md` הספציפיים שרלוונטיים. לעולם אל תקרא את כל התיקייה.
4. מותר להשתמש בתוכן מיילים **רק** בקבוצת ההתייעצות ובקבוצת DY. בכל קבוצה אחרת — אין לך גישה למיילים.
```

- [ ] **Step 2: Add `/mail` to `router.md`'s intent table** — command `/mail` + Hebrew NL triggers («מייל», «מיילים», «אינבוקס», «תיבת דואר») → the AGENTS.md §📧 flow (sync → INDEX → specific files). Match the table's existing format.

- [ ] **Step 3: Verify + commit** — prompt/skill files hot-reload (no restart needed). `git commit -m "feat(digit): mail access rules + /mail intent"`

---

### Task 5: The twice-daily cron (OpenClaw native)

**Files:** none created — one CLI command (config lives in OpenClaw's cron store).

- [ ] **Step 1: Add the job**

```bash
cd /home/davidtobol2580/open_claw && ./openclaw cron add \
  --name digit-mail-check --agent digit \
  --cron "0 7,16 * * *" --tz Asia/Jerusalem \
  --announce --channel whatsapp --to 1203630000000000DY@g.us \
  --best-effort-deliver \
  "בדיקת מיילים תקופתית. בצע: (1) הרץ node tools/gmail-sync.mjs ; (2) קרא את data/mail/pending-attention.json ; (3) אם הרשימה ריקה — ענה בדיוק NO_REPLY ותו לא; (4) אחרת, לכל מייל ברשימה פתח את הקובץ שלו תחת data/mail/messages/ וכתוב הודעה אחת בעברית לקבוצה: לכל מייל 2-3 שורות מה כתוב בו + המלצה קונקרטית מה לעשות (להשיב/להתעלם/להעביר/לפעול). אל תדווח על שום מייל שאינו ברשימה."
```
⚠️ Before running, confirm the delivery flags against `./openclaw cron add --help` (`--to`/`--channel` naming) and mirror EXACTLY how `zorro-daily` is configured: `./openclaw cron list --json | python3 -m json.tool | grep -A6 zorro-daily`.

- [ ] **Step 2: Verify creds reach cron runs** — the gateway systemd drop-in (`~/.config/systemd/user/openclaw-gateway.service.d/secrets.conf`, same file that carries `TAVILY_API_KEY`) must gain `Environment=GMAIL_USER=…` + `GMAIL_APP_PASSWORD=…` **OR** rely on the tool's env-file fallback (preferred — zero gateway changes; the fallback reads `~/.openclaw/secrets/gmail-digit.env` directly). Prefer the fallback; do NOT restart the gateway for this feature.

- [ ] **Step 3: Test-fire without waiting for 07:00** — `./openclaw cron run digit-mail-check` (check exact subcommand in `./openclaw cron --help`; job-scout used the same for its dry-runs). With creds still placeholders expect a clean failure logged; with real creds expect either NO_REPLY (nothing pending) or a Hebrew summary in the DY group.

- [ ] **Step 4: Commit docs breadcrumb** — append the cron's existence to `workspace-realestate/CLAUDE.md` (one short paragraph under a new "📧 Gmail mirror" heading: tool, data/mail layout, cron name/schedule, DY-only alerts, spec path). `git commit -m "docs(digit): gmail mirror + digit-mail-check cron"`

---

### Task 6: Credentials + backfill + end-to-end verification (⏸ blocked on David)

**Needs David (one-time, ~5 min):** on the company Google account — enable 2-Step Verification → create an App Password (myaccount.google.com/apppasswords) → paste into `~/.openclaw/secrets/gmail-digit.env`. Also confirm IMAP is enabled (Gmail → Settings → Forwarding and POP/IMAP).

- [ ] **Step 1: Fill real creds; `chmod 600` re-checked.**
- [ ] **Step 2: Backfill** — `node tools/gmail-sync.mjs --verbose --full`. Expected: N message files (N = mailbox size, low hundreds), INDEX.md rows == N, state.json has `lastUid`, pending-attention.json exists. Spot-check 2–3 Markdown files incl. one Hebrew mail (RTL text intact) and one with attachments (names/sizes listed, nothing downloaded).
- [ ] **Step 3: Incremental** — run again: "0 new message(s)", runtime < 10s.
- [ ] **Step 4: Verify read-only** — in the Gmail web UI confirm previously-unread messages are STILL unread after the mirror.
- [ ] **Step 5: Live drill** — send a test mail from an outside address → `./openclaw cron run digit-mail-check` → digit posts summary+recommendation to the DY group, and does NOT re-report it on the next run. Then ask digit in the consultation group «דיגיט מה היה במייל האחרון» → INDEX-based answer.
- [ ] **Step 6: Final commit + update memory checkpoint** (`digit-gmail-sync-checkpoint.md`: status → LIVE).
