# Multi-Tenant Job-Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-user (David) job-scout into a generic multi-person bot — owner (David: full pipeline) + guests (guest: push + light Q&A, no Sheet/Gmail) — driven by a `people/` registry, while folding in the efficiency fixes (Gmail incremental, ledger pre-filter, config-driven LinkedIn keywords, duplicate-validation cleanup).

**Architecture:** A new `tools/lib/people.mjs` resolver + `workspace/.config/people.json` registry are the single source of truth for per-person paths and capabilities. Each tool gains `--person <id>`. The scout prompt loops over enabled people; Gmail/Sheet steps are gated by per-person capabilities. Q&A routing resolves the sender (owner via `fromMe` / known guest / unknown) through the `chat-log` hook writing `last-inbound.json`.

**Tech Stack:** Node 22 (ESM `.mjs`), `node:test` + `node:assert` (existing test convention), OpenClaw CLI, Tavily, ImapFlow, gramjs.

---

## ⚠️ Environment notes (read before starting)

- **Not a git repo.** The "Checkpoint" steps below replace commits: run the named tests/commands and confirm expected output before moving on. Make file backups where stated (`cp … .bak-<task>`).
- **Live bot — do not break it mid-build.** The cron scout (08:00 Asia/Jerusalem) and on-demand WhatsApp Q&A run off these files. Sequencing is **copy-first → update tools/prompts → verify → cleanup-last**, so the old paths keep working until the new ones are proven. **Do NOT restart the gateway** (CLAUDE.md: skills/prompts hot-reload; restarting drops in-flight replies). Avoid running tasks while David is actively chatting.
- **Two skill locations.** Tools currently fall back to `~/.openclaw/agents/main/skills/job-scout/…`. Source of truth is `workspace/`. After edits, verify the agent picks them up (final task).
- **Test runner:** `node <file>.test.mjs` (the repo's convention; see existing `*.test.mjs`). Expected pass output ends with `# fail 0`.
- **All paths absolute.** `WS=~/open_claw/workspace`.

---

## File structure

**Create:**
- `workspace/.config/people.json` — registry (shared infra + people array)
- `workspace/tools/lib/people.mjs` — path/capability resolver
- `workspace/tools/lib/people.test.mjs` — resolver tests
- `workspace/tools/ledger.mjs` — per-person sent-suggestions read/write CLI
- `workspace/tools/ledger.test.mjs` — ledger tests
- `workspace/people/david/{profile/*, sources.json, allowed-locations.json, data/*}` — migrated from current locations
- `workspace/people/yossi/{profile/*, sources.json, allowed-locations.json, data/}` — guest (financial/AML)

**Modify:**
- `workspace/tools/search.mjs` — `--person`, resolver, linkedin keywords from sources.json
- `workspace/tools/telegram.mjs` — `--person`, per-person state via resolver
- `workspace/tools/gmail-search.mjs` — `--person` incremental (gmail-state + `--after-uid`)
- `workspace/tools/hooks/chat-log/handler.js` — capture sender → `last-inbound.json` + label by person
- `workspace/tools/hooks/chat-log/handler.test.mjs` — sender tests
- `workspace/skills/job-scout/prompt-scout.md` — loop over people; remove dup LinkedIn check; ledger usage
- `workspace/skills/job-scout/prompt-qa.md` — 3-case routing; guest/unknown behavior; admin commands
- `workspace/skills/job-scout/router.md` — owner admin commands + Hebrew NL
- `workspace/skills/job-scout/SKILL.md` — generalize owner/guests
- `workspace/CLAUDE.md` (project root `~/open_claw/CLAUDE.md`) — multi-tenant model + cron fix

**Cleanup-last (only after everything verified):** remove the now-duplicated originals
(`workspace/profile/{cv.pdf,cv-summary.json,profile.md}`, `workspace/profile/yossi/`,
`skills/job-scout/sources.json`, `skills/job-scout/allowed-locations.json`,
`workspace/data/{sent-suggestions.json,telegram-state.json}`).

---

## Task 1: `people.mjs` resolver (no behavior change — purely additive)

**Files:**
- Create: `workspace/tools/lib/people.mjs`
- Test: `workspace/tools/lib/people.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `workspace/tools/lib/people.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePerson, listEnabled, personByE164 } from './people.mjs';

const REG = {
  shared: { whatsapp_group_id: 'G@g.us', default_person: 'david' },
  people: [
    { id: 'david', name: 'David', role: 'owner', enabled: true, match_e164: [],
      capabilities: { sheet: true, gmail: true, telegram: true } },
    { id: 'yossi', name: 'אורח', role: 'guest', enabled: true, match_e164: ['972500000000'],
      capabilities: { sheet: false, gmail: false, telegram: false } },
    { id: 'old', name: 'Old', role: 'guest', enabled: false, match_e164: ['972500000000'],
      capabilities: { sheet: false, gmail: false, telegram: false } },
  ],
};

test('resolvePerson returns person with convention paths', () => {
  const p = resolvePerson('yossi', REG);
  assert.equal(p.id, 'yossi');
  assert.ok(p.paths.sources.endsWith('/people/yossi/sources.json'));
  assert.ok(p.paths.cvSummary.endsWith('/people/yossi/profile/cv-summary.json'));
  assert.ok(p.paths.ledger.endsWith('/people/yossi/data/sent-suggestions.json'));
});

test('resolvePerson unknown id → null', () => {
  assert.equal(resolvePerson('nope', REG), null);
});

test('listEnabled excludes disabled people', () => {
  const ids = listEnabled(REG).map((p) => p.id);
  assert.deepEqual(ids, ['david', 'yossi']);
});

test('personByE164 fromMe → owner', () => {
  const p = personByE164('whatever', { fromMe: true }, REG);
  assert.equal(p.id, 'david');
});

test('personByE164 known guest matches digits-only (with +, dashes)', () => {
  const p = personByE164('+972-50-000-0000', { fromMe: false }, REG);
  assert.equal(p.id, 'yossi');
});

test('personByE164 unknown sender → null', () => {
  assert.equal(personByE164('972999999999', { fromMe: false }, REG), null);
});

test('personByE164 disabled guest does not match', () => {
  assert.equal(personByE164('972500000000', { fromMe: false }, REG), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/open_claw/workspace && node tools/lib/people.test.mjs`
Expected: FAIL — `Cannot find module './people.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `workspace/tools/lib/people.mjs`:
```js
// Per-person path & capability resolver — single source of truth for the people registry.
import { readFileSync } from 'node:fs';

const WORKSPACE = '~/open_claw/workspace';
const REGISTRY_PATH = `${WORKSPACE}/.config/people.json`;

export function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

function withPaths(p) {
  const base = `${WORKSPACE}/people/${p.id}`;
  return {
    ...p,
    paths: {
      base,
      profileDir: `${base}/profile`,
      cvSummary: `${base}/profile/cv-summary.json`,
      profileMd: `${base}/profile/profile.md`,
      sources: `${base}/sources.json`,
      locations: `${base}/allowed-locations.json`,
      dataDir: `${base}/data`,
      ledger: `${base}/data/sent-suggestions.json`,
      telegramState: `${base}/data/telegram-state.json`,
      gmailState: `${base}/data/gmail-state.json`,
    },
  };
}

export function resolvePerson(id, registry = loadRegistry()) {
  const p = registry.people.find((x) => x.id === id);
  return p ? withPaths(p) : null;
}

export function listEnabled(registry = loadRegistry()) {
  return registry.people.filter((p) => p.enabled).map(withPaths);
}

const digits = (s) => String(s || '').replace(/\D/g, '');

// fromMe → the enabled owner; known e164 → that enabled person; else null (unknown sender).
export function personByE164(e164, { fromMe = false } = {}, registry = loadRegistry()) {
  if (fromMe) {
    const owner = registry.people.find((p) => p.role === 'owner' && p.enabled);
    if (owner) return withPaths(owner);
  }
  const d = digits(e164);
  if (d) {
    const m = registry.people.find(
      (p) => p.enabled && Array.isArray(p.match_e164) && p.match_e164.some((x) => digits(x) === d),
    );
    if (m) return withPaths(m);
  }
  return null;
}

export function sharedConfig(registry = loadRegistry()) {
  return registry.shared || {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/open_claw/workspace && node tools/lib/people.test.mjs`
Expected: PASS — output ends with `# fail 0`.

- [ ] **Step 5: Checkpoint** — confirm `# fail 0`. No other file references `people.mjs` yet, so the live bot is unaffected.

---

## Task 2: `ledger.mjs` (per-person sent-suggestions; reuses `jobId` from jobkey.mjs)

**Files:**
- Create: `workspace/tools/ledger.mjs`
- Test: `workspace/tools/ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `workspace/tools/ledger.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLedger, addToLedger } from './ledger.mjs';

function tmpLedger(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'sent-suggestions.json');
  writeFileSync(file, JSON.stringify(initial ?? { sent: [] }));
  return file;
}

test('checkLedger flags company/role already sent (by jobId)', () => {
  // jobId("Wix","QA Automation Engineer") computed once and stored
  const file = tmpLedger({ sent: [{ id: '___WILL_SET___' }] });
  // compute the real id via the same path the code uses
  const { jobId } = require('node:module'); // placeholder to keep step self-contained
  // (the implementation imports jobId from jobkey.mjs; here we verify via the public API)
  const res = checkLedger(file, [{ company: 'Acme', role: 'SDET' }]);
  assert.equal(Array.isArray(res.already), true);
  assert.equal(Array.isArray(res.fresh), true);
});

test('addToLedger appends new and de-dupes by id', () => {
  const file = tmpLedger({ sent: [{ id: 'aaa', company: 'A' }] });
  const n = addToLedger(file, [
    { id: 'aaa', company: 'A' }, // dup → ignored
    { id: 'bbb', company: 'B', url: 'u', title: 't', date: '2026-05-30' },
  ]);
  assert.equal(n, 2); // total in ledger
  const led = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(led.sent.map((x) => x.id), ['aaa', 'bbb']);
});

test('checkLedger: id present in ledger → already; absent → fresh', () => {
  const file = tmpLedger({ sent: [] });
  addToLedger(file, [{ id: 'zzz' }]);
  const res = checkLedger(file, [{ id: 'zzz' }, { id: 'yyy' }]);
  assert.deepEqual(res.already, ['zzz']);
  assert.deepEqual(res.fresh.map((x) => x.id), ['yyy']);
});
```

> Note: the first test is intentionally light (the public API shape); the third is the precise behavior contract for `id`-based check. Keep both.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/open_claw/workspace && node tools/ledger.test.mjs`
Expected: FAIL — `Cannot find module './ledger.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `workspace/tools/ledger.mjs`:
```js
#!/usr/bin/env node
// Per-person "sent jobs" ledger — dedup memory (the only memory for guests with no Sheet).
//   node ledger.mjs <person> check '[{"company":"..","role":".."}|{"id":".."}]'  -> {already:[ids], fresh:[items]}
//   node ledger.mjs <person> add   '[{"id":"..","url":"..","title":"..","company":"..","date":".."}]' -> prints total
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobId } from './jobkey.mjs';
import { resolvePerson } from './lib/people.mjs';

function read(file) {
  if (!existsSync(file)) return { sent: [] };
  try { const o = JSON.parse(readFileSync(file, 'utf8')); o.sent = o.sent || []; return o; }
  catch { return { sent: [] }; }
}

// Resolve each item to an id: prefer explicit item.id, else jobId(company, role).
function idOf(item) {
  if (item && typeof item.id === 'string' && item.id) return item.id;
  if (item && (item.company || item.role)) return jobId(item.company, item.role);
  return null;
}

export function checkLedger(file, items) {
  const led = read(file);
  const seen = new Set(led.sent.map((x) => x.id));
  const already = [];
  const fresh = [];
  for (const it of items) {
    const id = idOf(it);
    if (id && seen.has(id)) already.push(id);
    else fresh.push({ ...it, id: id ?? it.id ?? null });
  }
  return { already, fresh };
}

export function addToLedger(file, items) {
  const led = read(file);
  const seen = new Set(led.sent.map((x) => x.id));
  for (const it of items) {
    const id = idOf(it);
    if (id && !seen.has(id)) { led.sent.push({ ...it, id }); seen.add(id); }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(led));
  return led.sent.length;
}

function main() {
  const [personId, cmd, payload] = process.argv.slice(2);
  const p = resolvePerson(personId);
  if (!p) { process.stderr.write(`ledger: unknown person "${personId}"\n`); process.exit(2); }
  const file = p.paths.ledger;
  let items = [];
  try { items = payload ? JSON.parse(payload) : []; }
  catch (e) { process.stderr.write(`ledger: bad JSON payload: ${e.message}\n`); process.exit(2); }
  if (cmd === 'check') { process.stdout.write(JSON.stringify(checkLedger(file, items)) + '\n'); return; }
  if (cmd === 'add') { process.stdout.write(JSON.stringify({ total: addToLedger(file, items) }) + '\n'); return; }
  process.stderr.write('ledger: use <person> <check|add> <json>\n'); process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

> Fix the first test now that the API is known — replace its body with a concrete assertion:
```js
test('checkLedger flags company/role already sent (by jobId)', () => {
  const file = tmpLedger({ sent: [] });
  // add by company/role, then check the same → should be "already"
  addToLedger(file, [{ company: 'Acme', role: 'SDET' }]);
  const res = checkLedger(file, [{ company: 'Acme', role: 'SDET' }, { company: 'Acme', role: 'PM' }]);
  assert.equal(res.already.length, 1);
  assert.equal(res.fresh.length, 1);
  assert.equal(res.fresh[0].role, 'PM');
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/open_claw/workspace && node tools/ledger.test.mjs`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Checkpoint** — confirm `# fail 0`. `ledger.mjs` is not yet referenced by prompts; live bot unaffected.

---

## Task 3: Create the registry + migrate David (copy-first; originals kept as backup)

**Files:**
- Create: `workspace/.config/people.json`
- Create (copy): `workspace/people/david/**`

- [ ] **Step 1: Create the registry**

Write `workspace/.config/people.json`:
```json
{
  "shared": {
    "whatsapp_group_id": "120363000000000000@g.us",
    "default_person": "david"
  },
  "people": [
    {
      "id": "david", "name": "David", "role": "owner", "enabled": true,
      "match_e164": [],
      "capabilities": { "sheet": true, "gmail": true, "telegram": true },
      "sheet": {
        "webhook_url": "https://script.google.com/macros/s/<APPS_SCRIPT_DEPLOY_ID>/exec",
        "sheet_id": "<SHEET_ID>",
        "sheet_url": "https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit"
      },
      "gmail": { "user": "owner@example.com" },
      "telegram": { "channels": ["IL_QA_Job"], "max_messages_per_run": 100, "lookback_hours": 48 }
    },
    {
      "id": "yossi", "name": "אורח", "role": "guest", "enabled": true,
      "match_e164": ["972500000000"],
      "capabilities": { "sheet": false, "gmail": false, "telegram": false }
    }
  ]
}
```

- [ ] **Step 2: Copy David's files into the new layout (keep originals as backup)**

Run:
```bash
cd ~/open_claw/workspace
mkdir -p people/david/profile people/david/data
cp profile/cv.pdf profile/cv-summary.json profile/profile.md people/david/profile/
cp skills/job-scout/sources.json people/david/sources.json
cp skills/job-scout/allowed-locations.json people/david/allowed-locations.json
cp data/sent-suggestions.json people/david/data/sent-suggestions.json
cp data/telegram-state.json people/david/data/telegram-state.json
ls -R people/david
```
Expected: all files present under `people/david/`. (telegram-state carries `last_seen_id:54873` — preserved so Telegram stays incremental.)

- [ ] **Step 3: Add `linkedin_keywords` to David's sources.json**

Edit `workspace/people/david/sources.json` — add a top-level key alongside `tavily`:
```json
  "linkedin_keywords": [
    "Senior Automation Engineer Israel",
    "QA Automation Engineer Israel",
    "Senior QA Automation Israel"
  ]
```
(Same three strings currently hardcoded in `search.mjs` `LINKEDIN_KEYWORDS`.)

- [ ] **Step 4: Verify resolver sees David correctly**

Run:
```bash
cd ~/open_claw/workspace
node -e 'import("./tools/lib/people.mjs").then(m=>{const p=m.resolvePerson("david");console.log(p.id, require("fs").existsSync(p.paths.cvSummary), require("fs").existsSync(p.paths.sources), require("fs").existsSync(p.paths.ledger))})'
```
Expected: `david true true true`.

- [ ] **Step 5: Checkpoint** — registry valid JSON, David's files copied, resolver resolves real paths. Originals untouched → live bot still works on old paths.

---

## Task 4: `search.mjs` → `--person` + resolver + linkedin keywords from config

**Files:**
- Modify: `workspace/tools/search.mjs`
- Backup: `cp workspace/tools/search.mjs workspace/tools/search.mjs.bak-task4`

- [ ] **Step 1: Replace the config-path resolution and LinkedIn keyword source**

In `workspace/tools/search.mjs`:

Remove the `SOURCES_PATHS` and `LOCATIONS_PATHS` const arrays and the hardcoded `LINKEDIN_KEYWORDS` const (lines ~14–27). Add at top (after imports):
```js
import { resolvePerson } from './lib/people.mjs';

// --person <id> (default: david). Resolve per-person sources + locations from the registry.
function personIdFromArgv() {
  const i = process.argv.indexOf('--person');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'david';
}
```

In `main()`, replace the `readFirstExisting(...)` lines with:
```js
  const person = resolvePerson(personIdFromArgv());
  if (!person) fail(`Unknown person "${personIdFromArgv()}"`);
  const sources = JSON.parse(readFileSync(person.paths.sources, 'utf8'));
  const locations = JSON.parse(readFileSync(person.paths.locations, 'utf8'));
  const locFilter = buildLocationFilter(locations);
  const LINKEDIN_KEYWORDS = Array.isArray(sources.linkedin_keywords) ? sources.linkedin_keywords : [];
```
(`readFirstExisting` helper can be deleted; `existsSync` import may become unused — remove it.)

- [ ] **Step 2: Verify David's search still works (live behavior preserved)**

Run:
```bash
cd ~/open_claw/workspace && node tools/search.mjs --person david 2>/tmp/search.err | head -c 200; echo; echo "---stderr---"; head -5 /tmp/search.err
```
Expected: JSON `{"ok":true,"count":N,"candidates":[…]}` (N ≥ 0). No "Unknown person" / parse errors.

- [ ] **Step 3: Verify default (no --person) still resolves to david**

Run: `cd ~/open_claw/workspace && node tools/search.mjs 2>/dev/null | head -c 60`
Expected: `{"ok":true,...` (back-compat: old prompt invocation without `--person` keeps working).

- [ ] **Step 4: Checkpoint** — both invocations return `ok:true`. LinkedIn keywords now sourced from `people/david/sources.json`.

---

## Task 5: `telegram.mjs` → `--person` + per-person state

**Files:**
- Modify: `workspace/tools/telegram.mjs`
- Backup: `cp workspace/tools/telegram.mjs workspace/tools/telegram.mjs.bak-task5`

- [ ] **Step 1: Resolve channels + state path per person**

In `workspace/tools/telegram.mjs`:

Add import: `import { resolvePerson } from './lib/people.mjs';`
Remove the hardcoded `STATE_PATH` const and the `CONFIG_PATHS`/`LOCATIONS_PATHS` arrays' use for telegram config.

In `fetch()`, after creds, replace config loading + state path:
```js
  const personId = (() => { const i = process.argv.indexOf('--person'); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'david'; })();
  const person = resolvePerson(personId);
  if (!person) fail(`Unknown person "${personId}"`);
  const tg = person.telegram || {};
  const channels = Array.isArray(tg.channels) ? tg.channels : [];
  if (channels.length === 0) fail('No telegram.channels configured for this person');
  const maxMessages = Number(tg.max_messages_per_run) || 100;
  const lookbackHours = Number(tg.lookback_hours) || 48;
  const STATE_PATH = person.paths.telegramState;
  const locations = JSON.parse(readFileSync(person.paths.locations, 'utf8'));
```
Update `loadState`/`saveState` to use the local `STATE_PATH` (pass it in, or close over it). Keep the rest of the incremental logic (`minId: lastSeen`, save `last_seen_id`) unchanged.

- [ ] **Step 2: Verify David's Telegram fetch still incremental**

Run:
```bash
cd ~/open_claw/workspace && node tools/telegram.mjs fetch --person david 2>/tmp/tg.err | tail -c 200; echo; tail -3 /tmp/tg.err
cat people/david/data/telegram-state.json
```
Expected: `{"ok":true,"count":N,...}` and `telegram-state.json` shows `last_seen_id` ≥ 54873 (incremental, not re-fetching all).

- [ ] **Step 3: Verify guest with telegram disabled fails cleanly (handled by prompt)**

Run: `cd ~/open_claw/workspace && node tools/telegram.mjs fetch --person yossi 2>&1 | head -c 120`
Expected: `{"ok":false,"error":"No telegram.channels configured for this person"}` (the scout prompt skips Telegram for guest since `telegram:false`).

- [ ] **Step 4: Checkpoint** — David incremental preserved; guest path returns a clean skip signal.

---

## Task 6: `gmail-search.mjs` → `--person` incremental (gmail-state + `--after-uid`)

**Files:**
- Modify: `workspace/tools/gmail-search.mjs`
- Backup: `cp workspace/tools/gmail-search.mjs workspace/tools/gmail-search.mjs.bak-task6`

- [ ] **Step 1: Add per-person incremental mode**

In `workspace/tools/gmail-search.mjs`, add import:
```js
import { readFileSync as _rf, writeFileSync as _wf, existsSync as _ex } from 'node:fs';
import { resolvePerson } from './lib/people.mjs';
```
After parsing `args`, add incremental resolution (only when `--person` is given and not a `--uid` lookup):
```js
let gmailStateFile = null;
let lastUid = null;
if (args.person && !args.uid) {
  const p = resolvePerson(String(args.person));
  if (!p) { console.error(JSON.stringify({ error: `Unknown person "${args.person}"` })); process.exit(2); }
  gmailStateFile = p.paths.gmailState;
  if (_ex(gmailStateFile)) {
    try { lastUid = JSON.parse(_rf(gmailStateFile, 'utf8')).last_uid ?? null; } catch { lastUid = null; }
  }
}
```
In the search branch (the `else` that does the `client.fetch`), set the effective `afterUid`:
```js
const afterUid = args['after-uid'] ? parseInt(args['after-uid'], 10) : (lastUid ?? null);
```
First run (no state) → `afterUid` null → fall back to `since` from `--days 2` (existing behavior). Track the max uid seen:
```js
let maxUid = lastUid || 0;
// inside the for-await loop, after pushing:
if (msg.uid > maxUid) maxUid = msg.uid;
```
After the loop, before printing, persist:
```js
if (gmailStateFile && maxUid) {
  try { _wf(gmailStateFile, JSON.stringify({ last_uid: maxUid, updated_at: new Date().toISOString() })); } catch { /* best-effort */ }
}
```

- [ ] **Step 2: Verify first run falls back to --days and writes state**

Run:
```bash
cd ~/open_claw/workspace
rm -f people/david/data/gmail-state.json
node tools/gmail-search.mjs --person david --days 2 2>/tmp/gm.err | head -c 120; echo
cat people/david/data/gmail-state.json 2>/dev/null
```
Expected: `{"ok":true,"count":N,...}` and a `gmail-state.json` with `last_uid` (if any mail in window). If env vars missing in this shell, expect the `GMAIL_USER…missing` error — then re-run via the launcher so env loads: `~/open_claw/openclaw …` is not needed (tool reads env); confirm `GMAIL_USER`/`GMAIL_APP_PASSWORD` are exported, else run under the same env the cron uses.

- [ ] **Step 3: Verify second run is incremental (after-uid from state)**

Run: `cd ~/open_claw/workspace && node tools/gmail-search.mjs --person david 2>/dev/null | head -c 120`
Expected: `{"ok":true,"count":M,...}` with M ≤ the first count (only mail newer than `last_uid`); often `count:0` if no new mail. State file `last_uid` unchanged or higher.

- [ ] **Step 4: Checkpoint** — incremental Gmail confirmed; ad-hoc `--uid`/`--days`/`--after-uid` still work unchanged.

---

## Task 7: `chat-log` hook — capture sender → `last-inbound.json` + label by person

**Files:**
- Modify: `workspace/tools/hooks/chat-log/handler.js`
- Modify: `workspace/tools/hooks/chat-log/handler.test.mjs`

- [ ] **Step 1: Write the failing test (sender capture + person label)**

Add to `workspace/tools/hooks/chat-log/handler.test.mjs`:
```js
test('decideLog captures senderE164 and fromMe for received group msg', () => {
  const ev = {
    type: 'message', action: 'received',
    context: {
      channelId: 'whatsapp', conversationId: 'G@g.us', content: 'שלום',
      timestamp: '2026-05-30T20:00:00.000Z',
      metadata: { senderE164: '972500000000', senderId: '972500000000@s.whatsapp.net', to: '972500000000' },
    },
  };
  const d = decideLog(ev, 'G@g.us');
  assert.equal(d.log, true);
  assert.equal(d.e164, '972500000000');
  assert.equal(d.fromMe, false);
});

test('decideLog marks fromMe when sender == own number (owner/self-chat)', () => {
  const ev = {
    type: 'message', action: 'received',
    context: {
      channelId: 'whatsapp', conversationId: 'G@g.us', content: 'hi',
      metadata: { senderE164: '972500000000', to: '972500000000' },
    },
  };
  const d = decideLog(ev, 'G@g.us');
  assert.equal(d.fromMe, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/open_claw/workspace && node tools/hooks/chat-log/handler.test.mjs`
Expected: FAIL — `d.e164` is `undefined`.

- [ ] **Step 3: Implement sender capture**

In `workspace/tools/hooks/chat-log/handler.js`, update `decideLog` to read metadata and return sender info (keep existing fields):
```js
export function decideLog(event, groupId) {
  const no = (reason) => ({ log: false, reason });
  if (!event || event.type !== "message") return no("not a message");
  if (event.action !== "received" && event.action !== "sent") return no(`action=${event.action}`);
  const ctx = event.context ?? {};
  if (ctx.channelId !== "whatsapp") return no(`channel=${ctx.channelId}`);
  if (!groupId || ctx.conversationId !== groupId) return no("other conversation");
  const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
  if (!text) return no("empty content");
  const meta = ctx.metadata ?? {};
  const e164 = (meta.senderE164 || meta.senderId || "").toString().replace(/@.*/, "") || undefined;
  const ownE164 = (meta.to || "").toString().trim() || undefined;
  const fromMe = !!(e164 && ownE164 && e164.replace(/\D/g, "") === ownE164.replace(/\D/g, ""));
  return {
    log: true,
    from: event.action === "received" ? "received" : "scotty",
    e164: event.action === "received" ? e164 : undefined,
    fromMe: event.action === "received" ? fromMe : undefined,
    text,
    ts: typeof ctx.timestamp === "string" ? ctx.timestamp : undefined,
  };
}
```

In the default `chatLog` handler, after computing `d`, resolve the person label and write `last-inbound.json` for received messages:
```js
import { personByE164 } from "~/open_claw/workspace/tools/lib/people.mjs";
const LAST_INBOUND = "~/open_claw/workspace/data/last-inbound.json";
// …inside chatLog, after `if (!d.log) return;`
let label = "Scotty";
if (d.from === "received") {
  let person = null;
  try { person = personByE164(d.e164, { fromMe: d.fromMe }); } catch { /* ignore */ }
  label = person ? person.name : "אורח";
  try { await writeFile(LAST_INBOUND, JSON.stringify({ e164: d.e164 ?? null, fromMe: !!d.fromMe, person: person?.id ?? null, ts: record.ts })); } catch { /* best-effort */ }
}
const record = { ts: d.ts || new Date().toISOString(), from: d.from === "scotty" ? "scotty" : (label), e164: d.e164, text: d.text };
```
Update `formatRecentMd` to print `r.from` directly as the speaker label (it is now the person name or "Scotty") instead of the hardcoded David/Scotty mapping:
```js
export function formatRecentMd(records, n, maxReply = 600) {
  const tail = records.slice(-n);
  const lines = tail.map((r) => {
    const who = r.from || "?";
    const text = who === "scotty" || who === "Scotty" ? truncate(r.text, maxReply) : r.text;
    const when = (r.ts || "").replace("T", " ").replace(/\..*$/, "");
    return `**${who}** (${when}): ${text}`;
  });
  return `# שיחות אחרונות (${tail.length})\n\n` + lines.join("\n\n") + "\n";
}
```
> Adjust existing `formatRecentMd` tests if they asserted the old "David"/"Scotty" mapping — update expected speaker to the new label.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ~/open_claw/workspace && node tools/hooks/chat-log/handler.test.mjs`
Expected: PASS — `# fail 0` (update any pre-existing assertions that broke due to the label change).

- [ ] **Step 5: Checkpoint** — sender captured, `last-inbound.json` written on inbound, RECENT_CHAT labels by person. Hook still best-effort (never throws).

---

## Task 8: Author guest (financial/AML guest)

**Files:**
- Create (move): `workspace/people/yossi/profile/{cv.pdf,cv-summary.json,profile.md}`
- Create: `workspace/people/yossi/sources.json`
- Create: `workspace/people/yossi/allowed-locations.json`
- Create dir: `workspace/people/yossi/data/`

- [ ] **Step 1: Move guest's existing profile into the new layout**

Run:
```bash
cd ~/open_claw/workspace
mkdir -p people/yossi/profile people/yossi/data
cp profile/yossi/cv.pdf profile/yossi/cv-summary.json profile/yossi/profile.md people/yossi/profile/
ls people/yossi/profile
```
Expected: three files present.

- [ ] **Step 2: Author guest's sources.json**

Write `workspace/people/yossi/sources.json`:
```json
{
  "tavily": {
    "queries": [
      {"query": "Financial Analyst Israel site:alljobs.co.il", "max": 8},
      {"query": "אנליסט פיננסי site:alljobs.co.il", "max": 8},
      {"query": "AML Analyst Israel site:alljobs.co.il", "max": 6},
      {"query": "Compliance Analyst Israel site:alljobs.co.il", "max": 6},
      {"query": "Fraud Analyst Israel site:alljobs.co.il", "max": 6},
      {"query": "אנליסט הלבנת הון site:drushim.co.il", "max": 6},
      {"query": "Financial Analyst Israel site:drushim.co.il", "max": 8},
      {"query": "BI Analyst Israel site:jobmaster.co.il", "max": 6},
      {"query": "Data Analyst finance Israel site:jobmaster.co.il", "max": 6},
      {"query": "אנליסט מודיעין פיננסי site:alljobs.co.il", "max": 5},
      {"query": "Compliance AML Analyst bank Israel site:linkedin.com", "max": 5}
    ],
    "time_range": "day",
    "search_depth": "basic"
  },
  "linkedin_keywords": [
    "Financial Analyst Israel",
    "AML Compliance Analyst Israel",
    "Fraud Analyst Israel"
  ]
}
```

- [ ] **Step 3: Author guest's allowed-locations.json**

Write `workspace/people/yossi/allowed-locations.json`:
```json
{
  "allowed": {
    "en": ["Ramat HaHayal", "Azrieli", "Tel Aviv", "Tel-Aviv", "Ramat Gan", "Bursa", "Bnei Brak", "Ramat HaSharon", "Givatayim"],
    "he": ["רמת החייל", "עזריאלי", "תל אביב", "תל-אביב", "רמת גן", "בורסה", "בני ברק", "רמת השרון", "גבעתיים"]
  },
  "blocked": {
    "en": ["Jerusalem", "Haifa", "Be'er Sheva", "Beer Sheva", "Netanya", "Ashdod", "Eilat", "Petah Tikva", "Herzliya", "Ra'anana", "Raanana", "Kfar Saba"],
    "he": ["ירושלים", "חיפה", "באר שבע", "נתניה", "אשדוד", "אילת", "פתח תקווה", "פ\"ת", "הרצליה", "רעננה", "כפר סבא"]
  },
  "remote_handling": {
    "remote_il_ok": true,
    "remote_global_blocked": true,
    "patterns_remote_il": ["Remote (Israel)", "Remote - Israel", "עבודה מהבית - ישראל", "Remote / Israel"],
    "patterns_remote_global": ["Worldwide", "Anywhere", "Global Remote", "EMEA", "EU only"]
  }
}
```

- [ ] **Step 4: Verify guest's search runs end-to-end**

Run:
```bash
cd ~/open_claw/workspace && node tools/search.mjs --person yossi 2>/tmp/ys.err | head -c 200; echo; head -3 /tmp/ys.err
```
Expected: `{"ok":true,"count":N,"candidates":[…]}` — candidates location-filtered to guest's allowed cities. (N may be small/0 depending on the day; `ok:true` is the success criterion.)

- [ ] **Step 5: Checkpoint** — guest resolves, searches finance roles, filters to his cities.

---

## Task 9: Rewrite `prompt-scout.md` to loop over people

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md`
- Backup: `cp … prompt-scout.md.bak-task9`

- [ ] **Step 1: Replace Step 0 with a per-person loop preamble**

At the top of the pipeline (after the intro), insert:
```markdown
## Step 0 — Load the people registry and loop

```bash
cat ~/open_claw/workspace/.config/people.json
```
Run the full pipeline below **once per enabled person** (`people[].enabled == true`). For each person `P`:
- profile/CV: `cat workspace/people/<P.id>/profile/cv-summary.json`
- sources/locations are read by the tools via `--person <P.id>` (do not pass paths yourself).
- capabilities gate the Sheet/Gmail steps: `P.capabilities.sheet`, `.gmail`, `.telegram`.
- the WhatsApp group is shared (`shared.whatsapp_group_id`); each person gets a SEPARATE message labelled with `P.name`.
```

- [ ] **Step 2: Parameterize Steps 1, 1b by person; delete the manual Step 1c**

- Step 1: `cd …/tools && node search.mjs --person <P.id>`
- Step 1b: only if `P.capabilities.telegram` → `node telegram.mjs fetch --person <P.id>`; else skip Telegram for P.
- **Delete Step 1c** ("Validate job URLs (LinkedIn only)") entirely — `search.mjs` already drops closed LinkedIn postings. Replace with one line: "URL validation for LinkedIn is handled inside `search.mjs`; if a candidate carries a `⚠️ לא ניתן לאמת קישור` note, keep it."

- [ ] **Step 3: Insert the ledger pre-filter into Step 3 and gate the Sheet**

Edit Step 3 ("Merge duplicates & dedupe"):
```markdown
**3a. Ledger pre-filter (ALWAYS, before scoring overhead pays off):**
```bash
cd …/tools && node ledger.mjs <P.id> check '[{"company":"..","role":".."}, …]'
```
Drop every candidate whose `{company,role}` is in the returned `already` list — those were sent before.

**3b. Sheet dedupe — only if `P.capabilities.sheet`:** (the existing 3a–3c sheet logic). If `P.capabilities.sheet == false`, the ledger from 3a is the ONLY dedup set — skip all `sheet.mjs` calls for P.
```

- [ ] **Step 4: Gate Steps 4 and 5 by capability**

- Step 4 (append to Sheet): wrap in "If `P.capabilities.sheet`:" — else skip (the ledger in Step 7b is P's record).
- Step 5 (Gmail status sync): wrap in "If `P.capabilities.gmail`:" — and change the command to `node gmail-search.mjs --person <P.id>` (incremental). Else skip the entire Gmail section for P.

- [ ] **Step 5: Per-person report (Step 6) + ledger write (Step 7b via ledger.mjs)**

- Step 6: header `🔵 בוקר טוב {P.name}!`. If `P.capabilities.sheet == false` (guest): include ONLY the `🆕 משרות חדשות עבורך` block — omit "📊 סטטוס תיק", "📋 משרות פתוחות", needs_info, and the Sheet link. Owner: unchanged. **Always send (per David):** if P has 0 new jobs (owner: also 0 status changes), still send a short Hebrew heartbeat, e.g. `🔵 בוקר טוב {P.name}! אין משרות חדשות שתואמות אותך היום — אעדכן מחר 🤖` (owner keeps the full portfolio even when 0 new).
- Step 6b (sort): only if `P.capabilities.sheet`.
- Step 7: send to `shared.whatsapp_group_id` (one message per person).
- Step 7b: replace the inline `node -e` block with:
```bash
cd …/tools && node ledger.mjs <P.id> add '[{"id":"<content id>","url":"<url>","title":"<title>","company":"<company>","date":"<YYYY-MM-DD>"}, …]'
```
- Step 8: log per person → `data/runs/<YYYY-MM-DD>-<P.id>.json`.
- **No skip:** the old "send nothing if 0 new" Rule 6 is REPLACED — always send each enabled person their daily message (heartbeat when 0 new), per David's requirement.

- [ ] **Step 6: Verify the prompt is internally consistent**

Read the edited `prompt-scout.md` end-to-end. Confirm: every `node …` command includes `--person <P.id>` where applicable; no remaining reference to `workspace/profile/cv-summary.json` (now per-person); no Step 1c; ledger used in 3a and 7b.

- [ ] **Step 7: Checkpoint** — manual review only (markdown). Real end-to-end scout verification happens in Task 12.

---

## Task 10: `prompt-qa.md` 3-case routing + `router.md` admin commands

**Files:**
- Modify: `workspace/skills/job-scout/prompt-qa.md`
- Modify: `workspace/skills/job-scout/router.md`
- Backups: `.bak-task10`

- [ ] **Step 1: Add sender resolution at the top of prompt-qa.md**

Insert a new first section after the intro:
```markdown
## Step 0 — Identify the sender (route to the right person)

```bash
cat ~/open_claw/workspace/data/last-inbound.json 2>/dev/null
cat ~/open_claw/workspace/.config/people.json
```
Resolve the sender to a person:
- `last-inbound.person` is set → use that person.
- else `fromMe == true` → the `owner`.
- else `e164` matches a person's `match_e164` → that person.
- else → **unknown**.

Then branch:
- **owner (David):** full Q&A (this whole file as today).
- **guest (e.g. אורח):** light Q&A only — company info via web search, and "תראה לי שוב את המשרות שלי" by reading `workspace/people/<id>/data/sent-suggestions.json` + `RECENT_CHAT.md`. A Sheet/status/הגשתי request → reply politely in Hebrew that he has no application tracker. NEVER read David's Sheet/Gmail or another person's data.
- **unknown sender:** answer only general questions (no private data); reply that this is a personal job-search bot and being added needs the owner. Never expose anyone's data.
```

- [ ] **Step 2: Add owner-only admin handling to prompt-qa.md**

Append to the Intent table:
```markdown
| `/people` (owner only) | read people.json, list id/name/role/enabled. |
| `/disable <id>` / "תעצור ל-<שם>" (owner only) | set that person's `enabled:false` in people.json (reversible "delete"). Confirm in Hebrew. |
| `/enable <id>` / "תחזיר את <שם>" (owner only) | set `enabled:true`. |
| "תמחק לגמרי את <שם>" (owner only) | HARD delete — first ask for explicit confirmation ("לאשר מחיקה מלאה? כן/לא"); only on "כן" remove the `people/<id>/` folder + registry row. |
| `/add` (owner only) | reply that adding a person needs profile+CV files → dev session. |
A guest/unknown issuing any admin command → refuse politely (Hebrew). Admin edits to people.json take effect on the next message/run; they are normal workspace-config edits (NOT secrets/OAuth/gateway — those still need a dev session).
```

- [ ] **Step 3: Mirror the admin commands + Hebrew NL into router.md**

Add to `workspace/skills/job-scout/router.md` a section:
```markdown
## Owner-only people admin (multi-tenant)
- `/people` → list people.
- `/disable <id>` · NL: "תעצור ל-X", "תשבית את X", "תוריד את X מהקבוצה" → enabled:false (reversible).
- `/enable <id>` · NL: "תחזיר את X", "תפעיל את X" → enabled:true.
- "תמחק לגמרי את X" → hard delete, requires explicit "כן".
- Only the resolved `owner` may run these; guests/unknown are refused.
```

- [ ] **Step 4: Checkpoint** — read both files; confirm routing branch + admin table present and consistent with §5.1/§8.1 of the spec.

---

## Task 11: Update SKILL.md + CLAUDE.md + fix cron drift

**Files:**
- Modify: `workspace/skills/job-scout/SKILL.md`
- Modify: `~/open_claw/CLAUDE.md`
- Modify: `workspace/.config/job-scout.json` (cron drift)

- [ ] **Step 1: Generalize SKILL.md**

- Change the `description` and intro from "David Tubul's personal job search assistant" → "personal job-search assistant serving an **owner** (David) and optional **guests**, from one shared WhatsApp group."
- Mode routing: note Q&A first resolves the sender (owner/guest/unknown) per `prompt-qa.md` Step 0.
- Tool table: add `--person <id>` to search/telegram/gmail rows; add `ledger.mjs <person> <check|add>`; note gmail is incremental per-person.
- Hard rule 1: keep "only the shared group_id" (unchanged target; per-person content).
- Hard rule 6: **REPLACE** the old "0 new AND 0 status → send nothing" with "always send each enabled person a daily message; when 0 new, send a short heartbeat" (David's requirement). Update the same rule in CLAUDE.md.
- `workspace_files`: replace the David-specific profile paths with "`workspace/.config/people.json` + `workspace/people/<id>/…` per person."

- [ ] **Step 2: Update CLAUDE.md**

- Replace "## David / search profile (short)" single-user section with the multi-tenant model: registry, owner vs guest, per-person sources/locations/data, routing finding (group hides sender → hook→last-inbound; owner via fromMe; unknown→safe persona).
- Update "Layout" and "Live config quick reference" to mention `people.json` + `people/<id>/`.
- Note the new tools (`people.mjs`, `ledger.mjs`) and the gmail-incremental + ledger-prefilter efficiency changes.

- [ ] **Step 3: Fix cron drift**

Reconcile the schedule. Confirm the real cron:
```bash
~/open_claw/openclaw cron list 2>/dev/null | head -20
```
Set `workspace/.config/job-scout.json` `schedule_cron` and the CLAUDE.md/SKILL.md references to match the actual cron time (runs at 08:00 Asia/Jerusalem per `data/runs/*` = 05:00Z). If the intended time is 09:00, fix the cron via `openclaw cron edit <id>` instead and align docs. (Confirm intended time with David if ambiguous.)

- [ ] **Step 4: Checkpoint** — docs describe the multi-tenant system; cron value is consistent across config + docs + actual cron job.

---

## Task 12: Full verification + cleanup

**Files:** none new — verification, then remove duplicated originals.

- [ ] **Step 1: Run the entire test suite**

Run:
```bash
cd ~/open_claw/workspace
for t in tools/lib/people.test.mjs tools/ledger.test.mjs tools/jobkey.test.mjs tools/lib/location-filter.test.mjs tools/session-hygiene.test.mjs tools/hooks/chat-log/handler.test.mjs tools/hooks/ack-react/handler.test.mjs; do
  echo -n "$t -> "; node "$t" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; echo
done
```
Expected: every line ends `# fail 0`.

- [ ] **Step 2: Tool smoke tests (both people)**

Run:
```bash
cd ~/open_claw/workspace
node tools/sheet.mjs ping
node tools/search.mjs --person david 2>/dev/null | head -c 60; echo
node tools/search.mjs --person yossi 2>/dev/null | head -c 60; echo
node tools/ledger.mjs yossi check '[{"company":"X","role":"Analyst"}]'
```
Expected: sheet `{"ok":true,…}`; both searches `{"ok":true,…}`; ledger `{"already":[],"fresh":[…]}`.

- [ ] **Step 3: Routing dry-run**

Simulate inbound from guest and confirm last-inbound + resolution:
```bash
cd ~/open_claw/workspace
node -e '
import("./tools/hooks/chat-log/handler.js").then(async m=>{
  await m.default({type:"message",action:"received",context:{channelId:"whatsapp",conversationId:"120363000000000000@g.us",content:"היי",metadata:{senderE164:"972500000000",to:"972500000000"}}});
  console.log("last-inbound:", require("fs").readFileSync("data/last-inbound.json","utf8"));
})'
```
Expected: `last-inbound: {"e164":"972500000000","fromMe":false,"person":"yossi",…}`.

- [ ] **Step 4: Verify the agent uses the workspace skill copy**

Run: `cat ~/open_claw/workspace/skills/job-scout/.openclaw/source-origin.json` and confirm whether a synced copy exists at `~/.openclaw/agents/main/skills/job-scout/`. If so, confirm it hot-reloads from workspace (per CLAUDE.md) or re-sync per the project's mechanism. Do NOT restart the gateway.

- [ ] **Step 5: Live smoke (with David, not mid-conversation)**

Ask David to send `/people` in the group → expect a Hebrew list (david/owner/enabled, yossi/guest/enabled). Then a guest-style question routed to guest (David can test by having guest send one), confirming guest light-Q&A and no data leak.

- [ ] **Step 6: Cleanup the duplicated originals (only after Steps 1–5 pass)**

Run:
```bash
cd ~/open_claw/workspace
# keep backups one more cycle; move originals aside rather than hard-delete
mkdir -p .pre-multitenant-backup
mv profile/cv.pdf profile/cv-summary.json profile/profile.md .pre-multitenant-backup/ 2>/dev/null || true
mv profile/yossi .pre-multitenant-backup/yossi-old 2>/dev/null || true
mv skills/job-scout/sources.json skills/job-scout/allowed-locations.json .pre-multitenant-backup/ 2>/dev/null || true
mv data/sent-suggestions.json data/telegram-state.json .pre-multitenant-backup/ 2>/dev/null || true
```
Then re-run Step 1–2 to confirm nothing broke after removing the old paths. Remove the `*.bak-task*` tool backups once green.

- [ ] **Step 7: Final checkpoint** — all tests green, both people search, routing resolves, live `/people` works, old paths removed and nothing regressed.

---

## Self-review notes

- **Spec coverage:** D1 (Task 1,3), D2 (Task 3 shared group_id; Task 9 one msg/person), D3 (Task 9 guest report; Task 10 light Q&A), D4 (Task 3 copy + Task 12 cleanup), D5 (Task 7 + Task 10 Step 1); §5.1 three-case routing (Task 7, Task 10); §6 tools (Tasks 1,2,4,5,6); §7 scout loop (Task 9); §8/§8.1 Q&A + admin (Task 10); §9 hooks (Task 7); §10 guest (Task 8); §11 docs (Task 11); efficiency fixes — gmail incremental (Task 6), ledger pre-filter (Task 2,9), linkedin keywords→config (Task 3,4), dup-validation removal (Task 9 Step 2), cron drift (Task 11 Step 3). All covered.
- **Placeholders:** none — every code/edit step has concrete content; `<P.id>` is a documented loop variable, not a placeholder.
- **Type consistency:** `resolvePerson/listEnabled/personByE164` signatures match across Tasks 1,2,4,5,6,7,10; `checkLedger/addToLedger` match across Task 2 + Task 9; `decideLog` return shape (`e164`,`fromMe`) matches Task 7 test + handler + Task 10 routing.
