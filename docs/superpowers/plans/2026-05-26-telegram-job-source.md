# Telegram Job Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the public Telegram channel `IL_QA_Job` as a third job source that flows through the existing scout pipeline (CV scoring → Sheet → WhatsApp), pulled automatically each morning.

**Architecture:** A new Node CLI `tools/telegram.mjs` (gramjs/MTProto) authenticates as David's account via a stored `StringSession`, fetches messages newer than a per-channel marker, applies the shared location filter, and prints candidates in the same JSON shape as `search.mjs`. The scout prompt merges these candidates into the existing flow. Field extraction (role/company/location) is done by the LLM during scoring because posts are free-text Hebrew.

**Tech Stack:** Node 22, gramjs (`telegram` npm), existing `allowed-locations.json` filter, systemd-injected env secrets.

**Note — no git:** This project is not a git repo. Where the standard plan would `git commit`, this plan uses a **verification checkpoint** instead (run a command, confirm output). Do not run git.

---

## File Structure

- **Create** `workspace/tools/lib/location-filter.mjs` — shared `buildLocationFilter()` + `evaluateLocation()` (extracted from `search.mjs`).
- **Create** `workspace/tools/lib/location-filter.test.mjs` — plain `node --test` assertions for the filter.
- **Modify** `workspace/tools/search.mjs` — import the shared filter instead of its inline copy.
- **Create** `workspace/tools/telegram.mjs` — the `login` + `fetch` CLI.
- **Modify** `workspace/tools/package.json` — add `telegram` dependency (via `npm install`).
- **Modify** `workspace/.config/job-scout.json` — add the `telegram` config section.
- **Modify** `workspace/skills/job-scout/prompt-scout.md` — add Step 1b + scoring note.
- **Create** `workspace/skills/job-scout/tools/telegram-fetch.md` — how-to doc.
- **Modify** `workspace/skills/job-scout/SKILL.md` — add tool-table row + read-only Telegram rule.
- **Modify** `CLAUDE.md` — tools list, config section, secrets, "five things" intro.
- **State file** `workspace/data/telegram-state.json` — created at runtime by `telegram.mjs`, not by hand.
- **Secrets** `~/.config/systemd/user/openclaw-gateway.service.d/secrets.conf` — three `Environment=` lines (manual, documented in Task 7).

---

## Task 1: Extract the shared location filter

The location logic currently lives inline in `search.mjs` (`buildLocationFilter`, `evaluateLocation`). Extract it verbatim into a reusable module so `telegram.mjs` can apply identical filtering, then make `search.mjs` import it.

**Files:**
- Create: `workspace/tools/lib/location-filter.mjs`
- Create: `workspace/tools/lib/location-filter.test.mjs`
- Modify: `workspace/tools/search.mjs` (remove inline copy, import instead)

- [ ] **Step 1: Create the shared module**

Create `workspace/tools/lib/location-filter.mjs` with the two functions copied exactly from `search.mjs` (currently `search.mjs:171-219`), exported:

```js
// Shared center-Israel location filter, used by search.mjs and telegram.mjs.
// Takes the parsed allowed-locations.json and a text blob; decides keep/drop.

export function buildLocationFilter(loc) {
  const allowedEn = (loc?.allowed?.en || []).map((s) => s.toLowerCase());
  const allowedHe = loc?.allowed?.he || [];
  const blockedEn = (loc?.blocked?.en || []).map((s) => s.toLowerCase());
  const blockedHe = loc?.blocked?.he || [];
  const remoteGlobal = (loc?.remote_handling?.patterns_remote_global || []).map((s) => s.toLowerCase());
  const allowedOriginal = [...(loc?.allowed?.en || []), ...(loc?.allowed?.he || [])];
  return { allowedEn, allowedHe, blockedEn, blockedHe, remoteGlobal, allowedOriginal };
}

// Returns { keep: bool, location: string }
export function evaluateLocation(text, f) {
  const lower = text.toLowerCase();

  let matchedAllowed = '';
  for (const city of f.allowedOriginal) {
    const lc = city.toLowerCase();
    if (lower.includes(lc) || text.includes(city)) {
      matchedAllowed = city;
      break;
    }
  }
  const hasAllowed = matchedAllowed !== '';

  let hasBlocked = false;
  for (const c of f.blockedEn) {
    if (lower.includes(c)) { hasBlocked = true; break; }
  }
  if (!hasBlocked) {
    for (const c of f.blockedHe) {
      if (text.includes(c)) { hasBlocked = true; break; }
    }
  }

  let hasGlobalRemote = false;
  for (const p of f.remoteGlobal) {
    if (lower.includes(p)) { hasGlobalRemote = true; break; }
  }

  if (hasBlocked && !hasAllowed) return { keep: false, location: '' };
  if (hasGlobalRemote && !hasAllowed) return { keep: false, location: '' };

  return { keep: true, location: matchedAllowed };
}
```

- [ ] **Step 2: Write the failing test**

Create `workspace/tools/lib/location-filter.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationFilter, evaluateLocation } from './location-filter.mjs';

const loc = {
  allowed: { en: ['Tel Aviv', 'Herzliya'], he: ['תל אביב', 'מודיעין'] },
  blocked: { en: ['Jerusalem', 'Haifa'], he: ['ירושלים', 'חיפה'] },
  remote_handling: { patterns_remote_global: ['remote - global', 'worldwide'] },
};

test('keeps an allowed city', () => {
  const f = buildLocationFilter(loc);
  const r = evaluateLocation('QA Engineer in Tel Aviv', f);
  assert.equal(r.keep, true);
  assert.equal(r.location, 'Tel Aviv');
});

test('drops a blocked city with no allowed city', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('QA Engineer in Jerusalem', f).keep, false);
});

test('keeps blocked+allowed (allowed overrides)', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('Hybrid: Jerusalem and Tel Aviv', f).keep, true);
});

test('keeps text with no city mentioned (lenient)', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('דרוש QA Automation מנוסה', f).keep, true);
});

test('drops global-remote with no allowed city', () => {
  const f = buildLocationFilter(loc);
  assert.equal(evaluateLocation('Senior QA, remote - global', f).keep, false);
});

test('matches a Hebrew allowed city', () => {
  const f = buildLocationFilter(loc);
  const r = evaluateLocation('דרוש אוטומציה במודיעין', f);
  assert.equal(r.keep, true);
  assert.equal(r.location, 'מודיעין');
});
```

- [ ] **Step 3: Run the test — expect PASS**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node --test lib/location-filter.test.mjs`
Expected: all 6 tests pass (`# pass 6`). (The module already exists from Step 1, so this passes immediately — it locks the behavior before refactoring `search.mjs`.)

- [ ] **Step 4: Refactor `search.mjs` to import the module**

In `workspace/tools/search.mjs`: delete the inline `buildLocationFilter` and `evaluateLocation` function definitions (`search.mjs:171-219`), and add an import near the top imports (after line 9):

```js
import { buildLocationFilter, evaluateLocation } from './lib/location-filter.mjs';
```

Leave all call sites (`buildLocationFilter(locations)`, `evaluateLocation(combined, locFilter)`) unchanged — the names and signatures match.

- [ ] **Step 5: Verification checkpoint — search still runs**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node -e "import('./search.mjs').catch(e=>{console.error('IMPORT FAIL',e);process.exit(1)})" --check 2>&1 | head` — confirm no syntax/import error. Then confirm the functions are gone from `search.mjs`:
Run: `grep -c "function buildLocationFilter\|function evaluateLocation" /home/davidtobol2580/open_claw/workspace/tools/search.mjs`
Expected: `0`. And confirm the import line is present:
Run: `grep -n "location-filter.mjs" /home/davidtobol2580/open_claw/workspace/tools/search.mjs`
Expected: one match.

---

## Task 2: Install the gramjs dependency

**Files:**
- Modify: `workspace/tools/package.json` (auto-updated by npm)

- [ ] **Step 1: Install**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && npm install telegram`
Expected: completes; `telegram` added to `dependencies` in `package.json`.

- [ ] **Step 2: Verification checkpoint — import works**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node -e "import('telegram').then(m=>console.log('OK', typeof m.TelegramClient))"`
Expected: `OK function`.

---

## Task 3: Create `telegram.mjs` — `login` command

Build the CLI skeleton and the interactive `login` command first (it has no pipeline dependency and produces the session David needs).

**Files:**
- Create: `workspace/tools/telegram.mjs`

- [ ] **Step 1: Write the CLI skeleton + `login`**

Create `workspace/tools/telegram.mjs`:

```js
#!/usr/bin/env node
// Telegram job-source tool (gramjs / MTProto).
//   node telegram.mjs login   -> interactive one-time auth, prints a StringSession
//   node telegram.mjs fetch    -> pulls new channel messages as job candidates (JSON)
// Reads TELEGRAM_API_ID, TELEGRAM_API_HASH, and (for fetch) TELEGRAM_SESSION from env.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildLocationFilter, evaluateLocation } from './lib/location-filter.mjs';

const CONFIG_PATHS = [
  '/home/davidtobol2580/open_claw/workspace/.config/job-scout.json',
];
const LOCATIONS_PATHS = [
  '/home/davidtobol2580/open_claw/workspace/skills/job-scout/allowed-locations.json',
  '/home/davidtobol2580/.openclaw/agents/main/skills/job-scout/allowed-locations.json',
];
const STATE_PATH = '/home/davidtobol2580/open_claw/workspace/data/telegram-state.json';

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: String(msg) }));
  process.exit(1);
}

function readFirstExisting(paths, label) {
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')); }
      catch (e) { fail(`Failed to parse ${label} at ${p}: ${e.message}`); }
    }
  }
  fail(`No ${label} config found in: ${paths.join(', ')}`);
}

function getApiCreds() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) fail('TELEGRAM_API_ID / TELEGRAM_API_HASH not set in env');
  return { apiId, apiHash };
}

async function login() {
  const { apiId, apiHash } = getApiCreds();
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  const rl = readline.createInterface({ input, output });
  await client.start({
    phoneNumber: async () => (await rl.question('Phone (+972...): ')).trim(),
    password: async () => (await rl.question('2FA password (blank if none): ')).trim(),
    phoneCode: async () => (await rl.question('Code from Telegram: ')).trim(),
    onError: (err) => console.error('login error:', err?.message || err),
  });
  rl.close();
  await client.disconnect();
  console.error('\n--- Save this as TELEGRAM_SESSION in secrets.conf ---');
  console.log(client.session.save());
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'login') return login();
  if (cmd === 'fetch') return fetch();
  fail(`Unknown command "${cmd}". Use: login | fetch`);
}

main().catch((e) => fail(e?.message || e));
```

(`fetch` is added in Task 4; this step intentionally references it before defining it so the skeleton is complete. Do not run `fetch` yet.)

- [ ] **Step 2: Verification checkpoint — usage error path**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node telegram.mjs bogus`
Expected: prints `{"ok":false,"error":"Unknown command \"bogus\". Use: login | fetch"}` and exits 1. (This confirms the file parses and the skeleton runs even before `fetch` is implemented — `fetch` is referenced but not called on this path.)

---

## Task 4: Add the `fetch` command to `telegram.mjs`

**Files:**
- Modify: `workspace/tools/telegram.mjs`

- [ ] **Step 1: Add state helpers + `fetch`**

In `workspace/tools/telegram.mjs`, insert these functions **before** `async function main()`:

```js
function loadState() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
  }
  return {};
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function fetch() {
  const { apiId, apiHash } = getApiCreds();
  const sessionStr = process.env.TELEGRAM_SESSION;
  if (!sessionStr) fail('TELEGRAM_SESSION not set (run `node telegram.mjs login` first)');

  const config = readFirstExisting(CONFIG_PATHS, 'job-scout config');
  const tg = config?.telegram || {};
  const channels = Array.isArray(tg.channels) ? tg.channels : [];
  if (channels.length === 0) fail('No telegram.channels configured');
  const maxMessages = Number(tg.max_messages_per_run) || 100;
  const lookbackHours = Number(tg.lookback_hours) || 48;
  const cutoffSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;

  const locations = readFirstExisting(LOCATIONS_PATHS, 'allowed-locations');
  const locFilter = buildLocationFilter(locations);

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    fail('Telegram session invalid or expired (AUTH) — re-run login');
  }

  const state = loadState();
  const candidates = [];

  for (const channel of channels) {
    const lastSeen = Number(state?.[channel]?.last_seen_id) || 0;
    let maxId = lastSeen;
    let messages = [];
    try {
      messages = await client.getMessages(channel, { limit: maxMessages, minId: lastSeen });
    } catch (e) {
      process.stderr.write(`[telegram] channel "${channel}" failed: ${e?.message}\n`);
      continue;
    }
    for (const m of messages) {
      const id = m?.id;
      const text = (m?.message || '').trim();
      const dateSec = Number(m?.date) || 0;
      if (!id || !text) continue;
      if (id > maxId) maxId = id;
      if (dateSec && dateSec < cutoffSec) continue;
      const { keep, location } = evaluateLocation(text, locFilter);
      if (!keep) continue;
      candidates.push({
        source: `telegram:${channel}`,
        title: '',
        company: '',
        location,
        url: `https://t.me/${channel}/${id}`,
        snippet: text,
        score: 0,
        msg_id: id,
        date: dateSec ? new Date(dateSec * 1000).toISOString() : '',
      });
    }
    state[channel] = { last_seen_id: maxId, updated_at: new Date().toISOString() };
  }

  await client.disconnect();
  saveState(state);
  console.log(JSON.stringify({ ok: true, count: candidates.length, candidates }));
}
```

- [ ] **Step 2: Verification checkpoint — fetch guards on missing session**

Run: `cd /home/davidtobol2580/open_claw/workspace/tools && env -u TELEGRAM_SESSION TELEGRAM_API_ID=1 TELEGRAM_API_HASH=x node telegram.mjs fetch`
Expected: `{"ok":false,"error":"TELEGRAM_SESSION not set (run `node telegram.mjs login` first)"}`. (Confirms the command parses and the guard fires without needing live credentials.)

- [ ] **Step 3: Verification checkpoint — config-missing path**

Temporarily confirm the channels guard by running with a fake session but before config is added (if Task 6 not yet done). With real creds present, this is skipped. Otherwise:
Run: `cd /home/davidtobol2580/open_claw/workspace/tools && TELEGRAM_SESSION=x TELEGRAM_API_ID=1 TELEGRAM_API_HASH=x node telegram.mjs fetch`
Expected: either `{"ok":false,"error":"No telegram.channels configured"}` (if config section absent) or an AUTH/connection error `{"ok":false,...}` (if config present but session fake). Both are acceptable `ok:false` JSON — confirms no crash.

---

## Task 5: Add the `telegram` config section

**Files:**
- Modify: `workspace/.config/job-scout.json`

- [ ] **Step 1: Add the section**

In `workspace/.config/job-scout.json`, add a top-level `telegram` key (after the `gmail` block):

```json
  "telegram": {
    "channels": ["IL_QA_Job"],
    "max_messages_per_run": 100,
    "lookback_hours": 48
  }
```

Ensure the JSON remains valid (add the comma after the preceding block).

- [ ] **Step 2: Verification checkpoint — valid JSON + values**

Run: `node -e "const c=require('/home/davidtobol2580/open_claw/workspace/.config/job-scout.json'); console.log(JSON.stringify(c.telegram))"`
Expected: `{"channels":["IL_QA_Job"],"max_messages_per_run":100,"lookback_hours":48}`.

---

## Task 6: Integrate into the scout pipeline

**Files:**
- Modify: `workspace/skills/job-scout/prompt-scout.md`

- [ ] **Step 1: Add Step 1b after Step 1 (Tavily search)**

In `workspace/skills/job-scout/prompt-scout.md`, immediately after the Step 1 block (ends at line 20), insert:

```markdown
## Step 1b — Telegram channel fetch

```bash
cd /home/davidtobol2580/open_claw/workspace/tools && node telegram.mjs fetch
```
This outputs `{"ok":true,"count":N,"candidates":[{source:"telegram:<channel>",title:"",company:"",location,url,snippet,score,msg_id,date}]}`. The candidates are free-text Hebrew posts: `title`/`company`/`location` are EMPTY — you fill them in Step 2 from `snippet`. The `url` is the message permalink (use it as the source URL). **Merge these candidates into the same list** as the Step 1 Tavily candidates before scoring.

If the output is `{"ok":false,"error":...}`: skip Telegram and continue with the other sources. If the error text mentions `AUTH`/`session`/`expired`, remember to add this line to the WhatsApp report in Step 6: `⚠️ צריך login מחדש לטלגרם (דורש dev session)`.
```

- [ ] **Step 2: Add the extraction note to Step 2**

In the Step 2 section, after the `level` bullet (currently `prompt-scout.md:25`), add:

```markdown
- For `telegram:*` candidates only: first derive `title`, `company`, and `location` by reading the Hebrew `snippet` (the raw post). If the post gives no clear company, use the channel handle as a hint and leave company blank rather than guessing. Then score as below.
```

- [ ] **Step 3: Verification checkpoint — pipeline doc references the tool**

Run: `grep -n "telegram.mjs fetch\|telegram:\*\|Step 1b" /home/davidtobol2580/open_claw/workspace/skills/job-scout/prompt-scout.md`
Expected: matches for Step 1b heading, the `node telegram.mjs fetch` command, and the `telegram:*` scoring note.

---

## Task 7: Secrets + one-time setup (manual, documented)

This task is performed by David / a human operator; the steps are documented here and in the how-to doc. It cannot be automated from chat (interactive SMS code).

**Files:**
- Modify: `~/.config/systemd/user/openclaw-gateway.service.d/secrets.conf`

- [ ] **Step 1: Add API credentials**

David obtains `api_id` + `api_hash` from https://my.telegram.org. Add to `secrets.conf`:

```
Environment=TELEGRAM_API_ID=<id>
Environment=TELEGRAM_API_HASH=<hash>
```

Then: `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`

- [ ] **Step 2: One-time interactive login (David runs in his terminal)**

```
! cd /home/davidtobol2580/open_claw/workspace/tools && TELEGRAM_API_ID=<id> TELEGRAM_API_HASH=<hash> node telegram.mjs login
```
Enter phone → SMS code → 2FA (if set). Copy the printed session string (stdout, the long line).

- [ ] **Step 3: Add the session secret**

Add to `secrets.conf`: `Environment=TELEGRAM_SESSION=<string>` then `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`.

- [ ] **Step 4: Verification checkpoint — live fetch**

After the gateway restart, run a real fetch (env now injected by systemd; run via the gateway's environment or pass the three vars explicitly):
Run: `cd /home/davidtobol2580/open_claw/workspace/tools && node telegram.mjs fetch`
Expected: `{"ok":true,"count":N,"candidates":[...]}` with at least the channel processed (N may be small/0 on first run depending on recent posts; `ok:true` is the success signal). Confirm `workspace/data/telegram-state.json` now exists with a `last_seen_id` for `IL_QA_Job`.

---

## Task 8: Documentation

**Files:**
- Create: `workspace/skills/job-scout/tools/telegram-fetch.md`
- Modify: `workspace/skills/job-scout/SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the how-to doc**

Create `workspace/skills/job-scout/tools/telegram-fetch.md`:

```markdown
# telegram.mjs — Telegram channel job source

Pulls job posts from configured public Telegram channels via MTProto (gramjs), as David's account.

## Commands
- `node telegram.mjs login` — one-time interactive auth. Needs `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` in env; prompts phone/SMS code/2FA; prints a `StringSession` to save as `TELEGRAM_SESSION`. Run by a human (interactive).
- `node telegram.mjs fetch` — daily. Needs all three env vars. Pulls messages newer than the per-channel marker, filters by `allowed-locations.json`, prints candidates JSON (same shape as `search.mjs`). Updates `workspace/data/telegram-state.json`.

## Output
`{"ok":true,"count":N,"candidates":[{source:"telegram:<ch>",title:"",company:"",location,url,snippet,score,msg_id,date}]}`. Posts are free-text Hebrew; the LLM fills title/company/location from `snippet` during scoring. `url` is the message permalink.

## Config (`.config/job-scout.json` → `telegram`)
`channels` (array of public usernames), `max_messages_per_run` (default 100), `lookback_hours` (default 48).

## Secrets (`secrets.conf`, systemd-injected)
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (my.telegram.org), `TELEGRAM_SESSION` (from `login`).

## Failure / re-login
On expired session `fetch` prints `{"ok":false,"error":"...AUTH..."}`; the scout adds a re-login notice to the WhatsApp report. Re-run `login` and update `TELEGRAM_SESSION`.

## Read-only
Never post or reply in Telegram — read-only, same as Gmail.
```

- [ ] **Step 2: Update SKILL.md tool table + hard rule**

In `workspace/skills/job-scout/SKILL.md`, add a row to the "Real tools" table (after the Web/LinkedIn row):

```markdown
| Telegram channel job fetch | `node /home/davidtobol2580/open_claw/workspace/tools/telegram.mjs fetch` (gramjs/MTProto, location-filtered) |
```

And extend hard rule #2 area by adding a new bullet under "Hard boundaries":

```markdown
- Telegram: read-only. Never post or reply; only read channel posts.
```

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`:
1. In the "five things" intro (Daily scout bullet), add Telegram to the source list: `... + Telegram channel IL_QA_Job ...`.
2. In the `tools/` layout block, add: `│   ├── telegram.mjs           # Telegram channel fetch (gramjs/MTProto)`.
3. In "Live config quick reference", add: `- Telegram: channel(s) in config.telegram.channels (IL_QA_Job); secrets TELEGRAM_API_ID/HASH/SESSION`.
4. In the secrets line, append `, TELEGRAM_API_ID/HASH/SESSION`.

- [ ] **Step 4: Verification checkpoint — docs present**

Run: `ls /home/davidtobol2580/open_claw/workspace/skills/job-scout/tools/telegram-fetch.md && grep -c "telegram" /home/davidtobol2580/open_claw/workspace/skills/job-scout/SKILL.md /home/davidtobol2580/open_claw/CLAUDE.md`
Expected: the file lists, and both files report ≥1 match.

---

## Final verification

- [ ] `node --test workspace/tools/lib/location-filter.test.mjs` → all pass.
- [ ] `node telegram.mjs bogus` → `ok:false` usage error (parses).
- [ ] `node -e "import('./search.mjs')"` style check → search.mjs still imports cleanly.
- [ ] `telegram` section present and valid in `job-scout.json`.
- [ ] prompt-scout.md has Step 1b + scoring note.
- [ ] (After Task 7, live) `node telegram.mjs fetch` → `ok:true`, state file written.
