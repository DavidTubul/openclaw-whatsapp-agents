# Job-Scout Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Where tasks are independent they are tagged `[parallel-safe]` and can be dispatched concurrently.

**Goal:** Build a bidirectional OpenClaw agent ("Job-Scout") that scrapes LinkedIn + Israeli job boards daily for Senior/Mid Automation roles matching David's CV, tracks applications via Gmail + Google Sheets, and chats with David in a dedicated WhatsApp group.

**Architecture:** OpenClaw skill (markdown prompts + JSON config) + cron + Gateway. Runs LLM via `claude-cli` runtime (existing Claude subscription, $0 added). Stage flow: search → CV-match → dedupe → Gmail-status-update → Sheet-write → WhatsApp-send. Inbound WhatsApp messages route to a Q&A prompt that reuses the same tool surface.

**Tech Stack:** OpenClaw 2026.5.22, Node.js 22.22.3, plugins: `browser`, `tavily`, `google` (Gmail+Sheets+Drive), `anthropic` (via claude-cli), `memory-core`, `document-extract`. Channels: `whatsapp`. Scheduling: `openclaw cron`. Skill format: SKILL.md frontmatter + markdown body, JSON sidecar configs.

---

## File Structure

```
~/open_claw/
├── workspace/
│   ├── profile/
│   │   ├── cv.pdf                           # (exists)
│   │   ├── profile.md                       # (exists)
│   │   └── cv-summary.json                  # generated in Task 9
│   ├── .config/
│   │   └── job-scout.json                   # group id, sheet id, refs
│   └── data/
│       └── runs/<date>.json                 # per-run logs (optional)
├── docs/superpowers/
│   ├── specs/2026-05-26-linkedin-jobs-agent-design.md   # (exists)
│   └── plans/2026-05-26-job-scout-agent-implementation.md # (this file)
└── (wrapper) openclaw                       # (exists)

~/.openclaw/agents/main/skills/job-scout/
├── SKILL.md                                 # entry + frontmatter (Task 14)
├── prompt-scout.md                          # daily scout system prompt (Task 18)
├── prompt-qa.md                             # Q&A system prompt (Task 19)
├── router.md                                # intent routing rules (Task 20)
├── sources.json                             # search queries + sites (Task 15)
├── keywords.json                            # email status patterns (Task 16)
├── allowed-locations.json                   # city allow-list (Task 17)
└── tools/
    ├── linkedin-search.md                   # LinkedIn browser flow (Task 18 sub)
    ├── tavily-search.md                     # web search flow (Task 18 sub)
    ├── cv-match.md                          # scoring flow (Task 18 sub)
    ├── gmail-classify.md                    # email classification (Task 18 sub)
    └── sheets-rw.md                         # Sheets read/write (Task 18 sub)
```

**Single responsibility per file:** SKILL.md is the entry/metadata only; the long system prompts live in `prompt-scout.md` and `prompt-qa.md` (loaded by SKILL.md). Tool guides under `tools/` are reusable across both prompts.

---

## Pre-flight reference

All `openclaw` calls below must use Node 22. Use the wrapper:
```bash
~/open_claw/openclaw <args>
```
or for shell sessions:
```bash
source ~/.nvm/nvm.sh && nvm use 22 && openclaw <args>
```

Gateway is already running as systemd user service (`systemctl --user status openclaw-gateway` to verify).

---

# Phase 1 — Pre-flight Configuration (manual one-time)

### Task 1: Verify Gateway and Node 22

**Files:** none

- [ ] **Step 1: Verify Node 22 + openclaw**
```bash
source ~/.nvm/nvm.sh && nvm use 22 && openclaw --version
```
Expected: `OpenClaw 2026.5.22 (a374c3a)` or newer

- [ ] **Step 2: Verify Gateway running**
```bash
~/open_claw/openclaw status 2>&1 | grep "Gateway "
```
Expected: line containing `local · ws://127.0.0.1:18789 · reachable`

- [ ] **Step 3: If unreachable, restart**
```bash
~/open_claw/openclaw gateway restart
```
Then re-check Step 2.

---

### Task 2: Register Tavily API key  `[parallel-safe with Task 3,4,5,6,7]`

**Files:**
- Write: OpenClaw secrets store (via CLI)

- [ ] **Step 1: User signs up at tavily.com** (free tier)
Open https://tavily.com/ → Sign up → Dashboard → Copy API key (starts with `tvly-...`)

- [ ] **Step 2: Store key in OpenClaw secrets**
```bash
~/open_claw/openclaw secrets set TAVILY_API_KEY 'tvly-XXXXXXXXXXXXXXXXXXXXXXXXXXXX'
```
Expected: `Stored secret: TAVILY_API_KEY`

- [ ] **Step 3: Verify**
```bash
~/open_claw/openclaw secrets list | grep TAVILY
```
Expected: `TAVILY_API_KEY  (set)`

---

### Task 3: Enable required plugins  `[parallel-safe with Task 2,4,5,6,7]`

**Files:**
- Modify: `~/.openclaw/openclaw.json` (via CLI)

- [ ] **Step 1: Check baseline (these should already be enabled)**
```bash
~/open_claw/openclaw plugins list 2>&1 | grep -E "^│ .*(browser|tavily|google|memory-core|document-extract|anthropic)"
```
Expected: all 6 lines show `enabled`. If any show `disabled`, run the next step.

- [ ] **Step 2: Enable any missing plugin**
```bash
for p in browser tavily google memory-core document-extract anthropic; do
  ~/open_claw/openclaw plugins enable $p 2>&1 | tail -2
done
```
Expected: `Plugin enabled: <name>` for each (or "already enabled").

- [ ] **Step 3: Verify WhatsApp plugin is installed**
```bash
~/open_claw/openclaw channels list --all 2>&1 | grep -i whatsapp
```
Expected: a line including `WhatsApp:`. If it says `not installed`, run:
```bash
~/open_claw/openclaw plugins install @openclaw/whatsapp-channel
```

---

### Task 4: Pair WhatsApp Web  `[parallel-safe with Task 2,3,6,7]`

**Files:** none

- [ ] **Step 1: Initiate pairing**
```bash
~/open_claw/openclaw channels add --channel whatsapp
```
This prints a QR code (ASCII) and starts a session.

- [ ] **Step 2: User scans QR**
On phone: WhatsApp → Settings → Linked Devices → Link a Device → scan the QR shown in the terminal.

- [ ] **Step 3: Verify pairing**
```bash
~/open_claw/openclaw channels status --probe 2>&1 | grep -i whatsapp
```
Expected: `whatsapp ... ready` and shows your phone number `050-000-0000` (or `+972500000000`).

- [ ] **Step 4: Smoke test (send to self)**
```bash
~/open_claw/openclaw message send --channel whatsapp --target self --message "OpenClaw paired ✓"
```
Expected: message appears in your "Message yourself" chat.

---

### Task 5: Create WhatsApp group "Job Scout 🤖"  `[depends on Task 4]`

**Files:** none

- [ ] **Step 1: User creates the group on phone**
WhatsApp → New chat → New group → name: `Job Scout 🤖`. Add any contact as placeholder (you'll remove them next).

- [ ] **Step 2: User removes the placeholder**
Open the new group → Group info → tap the placeholder contact → Remove from group. Confirm.
Result: group has only you.

- [ ] **Step 3: User sends a message in the group**
Send `/ping` in the group. This is needed so OpenClaw can index the group via your recent activity.

- [ ] **Step 4: Discover group chat ID**
```bash
~/open_claw/openclaw directory list --channel whatsapp --kind group 2>&1 | grep -i scout
```
Expected: a line like `Job Scout 🤖 | id=120363xxxxxxxxxxxx@g.us`. Copy the id (everything up to `@g.us` inclusive).

- [ ] **Step 5: Save group id to config**
```bash
mkdir -p ~/open_claw/workspace/.config
cat > ~/open_claw/workspace/.config/job-scout.json <<'EOF'
{
  "whatsapp": {
    "group_id": "PASTE_GROUP_ID_HERE@g.us",
    "group_name": "Job Scout 🤖"
  },
  "google": {
    "gmail_address": "owner@example.com",
    "sheet_id": null
  },
  "tavily_secret_ref": "TAVILY_API_KEY",
  "schedule_cron": "0 9 * * *",
  "timezone": "Asia/Jerusalem"
}
EOF
```
Then edit `job-scout.json` and replace `PASTE_GROUP_ID_HERE@g.us` with the actual id from Step 4.

- [ ] **Step 6: Verify by sending to group**
```bash
GROUP_ID=$(jq -r .whatsapp.group_id ~/open_claw/workspace/.config/job-scout.json)
~/open_claw/openclaw message send --channel whatsapp --target "$GROUP_ID" --message "Group bound ✓"
```
Expected: message appears in the "Job Scout 🤖" group.

---

### Task 6: OAuth Google (Gmail + Sheets + Drive)  `[parallel-safe with Task 2,3,4,7]`

**Files:**
- Modify: OpenClaw google plugin config (via CLI)

- [ ] **Step 1: Start OAuth flow**
```bash
~/open_claw/openclaw configure --service google
```
Interactive prompts: choose `gmail-readonly + sheets + drive`. Press Enter to open browser.

- [ ] **Step 2: User authorizes in browser**
- Login as `owner@example.com`
- Approve scopes: Gmail Readonly, Google Sheets, Google Drive (file-level)
- Browser redirects to `localhost:18789/oauth/callback` → success page

- [ ] **Step 3: Verify token stored**
```bash
~/open_claw/openclaw secrets list 2>&1 | grep -i google
```
Expected: entries like `GOOGLE_OAUTH_TOKEN_DAVIDTUBUL10`.

- [ ] **Step 4: Smoke test Gmail**
```bash
~/open_claw/openclaw infer gmail search --query "newer_than:7d" --max-results 3 2>&1 | head -20
```
Expected: JSON list of 3 recent email metadata. If "no auth" → re-run Step 1.

- [ ] **Step 5: Smoke test Sheets**
```bash
~/open_claw/openclaw infer sheets list 2>&1 | head -10
```
Expected: list of your spreadsheets (or empty array if you have none).

---

### Task 7: Browser login to LinkedIn  `[parallel-safe with Task 2,3,4,6]`

**Files:**
- Modify: `~/.openclaw/browser-state/` (persisted session cookies)

- [ ] **Step 1: Open headed browser session**
```bash
~/open_claw/openclaw browser open --url https://www.linkedin.com/login --headed --persist linkedin
```
A Chromium window opens.

- [ ] **Step 2: User logs in**
Enter LinkedIn email + password (or use Google SSO). Complete any captcha/2FA.

- [ ] **Step 3: Verify session is logged in**
In the same browser window, navigate to `https://www.linkedin.com/jobs/` — you should see your personalized feed (not the public landing page).

- [ ] **Step 4: Close browser (session persists)**
Close the window. OpenClaw automatically saves cookies under the `linkedin` profile.

- [ ] **Step 5: Verify session reusable**
```bash
~/open_claw/openclaw browser fetch --url "https://www.linkedin.com/jobs/search/?keywords=automation&location=Israel" --persist linkedin --output /tmp/linkedin-test.html
```
Expected: `/tmp/linkedin-test.html` is 50KB+ and contains the word `Automation`. If file is tiny or contains `Please log in`, the session didn't persist — repeat Step 1.

```bash
ls -la /tmp/linkedin-test.html && grep -c -i "automation" /tmp/linkedin-test.html
```
Expected: file size >50000 and grep count >= 3.

---

# Phase 2 — Workspace Bootstrap

### Task 8: Create workspace directory structure

**Files:**
- Create: `~/open_claw/workspace/.config/` (exists from Task 5)
- Create: `~/open_claw/workspace/data/runs/`

- [ ] **Step 1: Create dirs**
```bash
mkdir -p ~/open_claw/workspace/data/runs
mkdir -p ~/.openclaw/agents/main/skills/job-scout/tools
```

- [ ] **Step 2: Verify**
```bash
ls -la ~/open_claw/workspace/data/ ~/.openclaw/agents/main/skills/job-scout/
```
Expected: both directories exist and are empty (the skill dir has only `tools/` subdir).

---

### Task 9: Generate cv-summary.json from CV

**Files:**
- Read: `~/open_claw/workspace/profile/cv.pdf`
- Create: `~/open_claw/workspace/profile/cv-summary.json`

- [ ] **Step 1: Extract CV text**
```bash
~/open_claw/openclaw infer document-extract \
  --file ~/open_claw/workspace/profile/cv.pdf \
  --output /tmp/cv-text.txt
```
Expected: `/tmp/cv-text.txt` contains the CV text (~3KB).

- [ ] **Step 2: Verify text extraction**
```bash
grep -c "QA Automation" /tmp/cv-text.txt
```
Expected: count >= 1 (matches David's title).

- [ ] **Step 3: Generate structured summary via LLM**
```bash
~/open_claw/openclaw infer model \
  --model anthropic/claude-sonnet-4-6 \
  --system "Extract candidate profile as JSON with keys: name, title_current, years_experience, levels_acceptable (array), languages (array), automation_tools (array), domains (array), english_level, hebrew_level. Only valid JSON output, no markdown." \
  --user "$(cat /tmp/cv-text.txt)" \
  --output ~/open_claw/workspace/profile/cv-summary.json
```

- [ ] **Step 4: Validate JSON**
```bash
jq . ~/open_claw/workspace/profile/cv-summary.json
```
Expected: pretty-printed JSON with name="David Tubul", years_experience=5, levels_acceptable contains "senior" and "mid".

- [ ] **Step 5: Manual sanity check**
Open the JSON. Confirm `automation_tools` includes Playwright, Selenium, Cypress; `languages` includes TypeScript, Python, Java.

---

### Task 10: Create Google Sheet "Job Search Tracker"

**Files:**
- Modify: `~/open_claw/workspace/.config/job-scout.json`

- [ ] **Step 1: Create the sheet via OpenClaw**
```bash
~/open_claw/openclaw infer sheets create \
  --title "Job Search Tracker — David Tubul" \
  --tab-title "Jobs" \
  --output /tmp/sheet-create.json
cat /tmp/sheet-create.json | jq -r .spreadsheetId
```
Expected: a string like `1AbC...XyZ` (the sheet ID).

- [ ] **Step 2: Write headers (row 1)**
```bash
SHEET_ID=$(jq -r .spreadsheetId /tmp/sheet-create.json)
~/open_claw/openclaw infer sheets update \
  --sheet-id "$SHEET_ID" \
  --range "Jobs!A1:O1" \
  --values '[["ID","תאריך מציאה","מקור","תפקיד","חברה","מיקום","רמה","ציון התאמה","נימוק","קישור","סטטוס","תאריך הגשה","הערות","זוהה ממייל","עודכן"]]'
```
Expected: `{"updatedRange":"Jobs!A1:O1","updatedRows":1,"updatedColumns":15}` in output.

- [ ] **Step 3: Apply header formatting (bold + freeze)**
```bash
~/open_claw/openclaw infer sheets format \
  --sheet-id "$SHEET_ID" \
  --range "Jobs!A1:O1" \
  --bold true --freeze-rows 1
```

- [ ] **Step 4: Save sheet id to config**
```bash
SHEET_ID=$(jq -r .spreadsheetId /tmp/sheet-create.json)
jq --arg id "$SHEET_ID" '.google.sheet_id = $id' \
  ~/open_claw/workspace/.config/job-scout.json \
  > /tmp/job-scout.json.tmp && mv /tmp/job-scout.json.tmp ~/open_claw/workspace/.config/job-scout.json
```

- [ ] **Step 5: Verify**
```bash
jq .google.sheet_id ~/open_claw/workspace/.config/job-scout.json
```
Expected: the sheet id string. Open `https://docs.google.com/spreadsheets/d/<id>` in browser to visually confirm.

---

# Phase 3 — Build the Skill

### Task 11: Write `sources.json`  `[parallel-safe with Tasks 12,13,14]`

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/sources.json`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/sources.json <<'EOF'
{
  "linkedin": {
    "url_template": "https://www.linkedin.com/jobs/search/?keywords={kw}&location=Israel&f_TPR=r86400&f_E=3%2C4&sortBy=DD",
    "browser_profile": "linkedin",
    "keywords": [
      "Automation Engineer",
      "QA Automation",
      "Test Automation",
      "SDET",
      "Senior QA",
      "Senior Automation"
    ],
    "max_results_per_keyword": 25,
    "notes": "f_TPR=r86400 = last 24h. f_E=3,4 = Associate+Mid-Senior level. We further filter in code."
  },
  "tavily": {
    "queries": [
      {"query": "Senior Automation Engineer Israel site:alljobs.co.il", "max": 8},
      {"query": "Senior QA Automation Israel site:alljobs.co.il", "max": 8},
      {"query": "Senior Automation Engineer Israel site:jobmaster.co.il", "max": 8},
      {"query": "Senior Automation Engineer Israel site:drushim.co.il", "max": 8},
      {"query": "Senior QA Automation Israel site:drushim.co.il", "max": 8},
      {"query": "Senior Automation Engineer Israel site:indeed.com", "max": 5},
      {"query": "Senior Automation Engineer Israel site:glassdoor.com", "max": 5},
      {"query": "Mid level Automation Engineer Israel site:alljobs.co.il", "max": 5},
      {"query": "Mid level Automation Engineer Israel site:jobmaster.co.il", "max": 5}
    ],
    "time_range": "day",
    "search_depth": "basic"
  }
}
EOF
```

- [ ] **Step 2: Validate JSON**
```bash
jq . ~/.openclaw/agents/main/skills/job-scout/sources.json | head -5
```
Expected: pretty JSON, no errors.

---

### Task 12: Write `keywords.json` (email status patterns)  `[parallel-safe with Tasks 11,13,14]`

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/keywords.json`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/keywords.json <<'EOF'
{
  "applied": {
    "patterns_en": [
      "thank you for applying",
      "application received",
      "we received your application",
      "your application to .* has been submitted",
      "thanks for your interest"
    ],
    "patterns_he": [
      "תודה על הגשתך",
      "תודה שהגשת מועמדות",
      "קיבלנו את מועמדותך",
      "הבקשה שלך התקבלה"
    ]
  },
  "interview": {
    "patterns_en": [
      "schedule (a |an )?(call|interview|phone screen)",
      "would like to (chat|talk|meet)",
      "next step",
      "phone screen",
      "technical interview",
      "let.?s set up a"
    ],
    "patterns_he": [
      "(נשמח|רוצים) (לקבוע|לשמוע)",
      "ראיון",
      "שיחת היכרות",
      "שיחה טלפונית",
      "מועד פגישה"
    ]
  },
  "rejected": {
    "patterns_en": [
      "unfortunately",
      "we regret",
      "moving forward with other candidates",
      "decided not to proceed",
      "not the right fit",
      "wish you (the )?best"
    ],
    "patterns_he": [
      "לצערנו",
      "החלטנו לא להמשיך",
      "החלטנו שלא להתקדם",
      "בהצלחה בהמשך"
    ]
  },
  "offer": {
    "patterns_en": [
      "pleased to offer",
      "offer letter",
      "we would like to extend an offer",
      "formal offer"
    ],
    "patterns_he": [
      "אנו שמחים להציע",
      "הצעת עבודה",
      "מציעים לך"
    ]
  },
  "noise_to_ignore": {
    "patterns": [
      "linkedin job alert",
      "weekly digest",
      "(?i)noreply.*indeed",
      "newsletter"
    ]
  }
}
EOF
```

- [ ] **Step 2: Validate**
```bash
jq 'keys' ~/.openclaw/agents/main/skills/job-scout/keywords.json
```
Expected: `["applied","interview","noise_to_ignore","offer","rejected"]`

---

### Task 13: Write `allowed-locations.json`  `[parallel-safe with Tasks 11,12,14]`

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/allowed-locations.json`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/allowed-locations.json <<'EOF'
{
  "allowed": {
    "en": ["Tel Aviv", "Tel-Aviv", "Ramat Gan", "Givatayim", "Bnei Brak", "Holon", "Bat Yam", "Rishon LeZion", "Rishon Lezion", "Rehovot", "Ness Ziona", "Lod", "Ramla", "Modi'in", "Modiin", "Herzliya", "Tel-Aviv-Yafo"],
    "he": ["תל אביב", "תל-אביב", "רמת גן", "גבעתיים", "בני ברק", "חולון", "בת ים", "ראשון לציון", "ראשל\"צ", "ראשל״צ", "רחובות", "נס ציונה", "לוד", "רמלה", "מודיעין", "הרצליה"]
  },
  "blocked": {
    "en": ["Jerusalem", "Petah Tikva", "Petach Tikva", "Petah Tikvah", "Netanya", "Haifa", "Be'er Sheva", "Beer Sheva", "Ashdod", "Ashkelon", "Rosh HaAyin", "Rosh Ha'Ayin", "Hadera", "Nazareth", "Eilat", "Kfar Saba", "Ra'anana", "Raanana"],
    "he": ["ירושלים", "פתח תקווה", "פתח-תקווה", "פ\"ת", "נתניה", "חיפה", "באר שבע", "אשדוד", "אשקלון", "ראש העין", "חדרה", "נצרת", "אילת", "כפר סבא", "רעננה"]
  },
  "remote_handling": {
    "remote_il_ok": true,
    "remote_global_blocked": true,
    "patterns_remote_il": ["Remote (Israel)", "Remote - Israel", "עבודה מהבית - ישראל", "Remote / Israel"],
    "patterns_remote_global": ["Worldwide", "Anywhere", "Global Remote", "EMEA", "EU only"]
  }
}
EOF
```

- [ ] **Step 2: Validate**
```bash
jq '.allowed.en | length' ~/.openclaw/agents/main/skills/job-scout/allowed-locations.json
```
Expected: 17 (count of allowed English city names).

---

### Task 14: Write `SKILL.md` (entry + metadata)  `[parallel-safe with Tasks 11,12,13]`

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/SKILL.md`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/SKILL.md <<'SKILLEOF'
---
name: job-scout
description: Job search assistant for David Tubul. Daily scout of LinkedIn + Israeli/global job boards for Senior/Mid Automation roles in center-Israel, matched against his CV. Updates Google Sheet tracker, syncs application status from Gmail, and chats in WhatsApp group "Job Scout 🤖".
version: 1.0.0
model: anthropic/claude-opus-4-7
fallback_models:
  - anthropic/claude-sonnet-4-6
  - anthropic/claude-haiku-4-5
triggers:
  - cron: "0 9 * * *"
    timezone: "Asia/Jerusalem"
    prompt: "scout"
  - channel: whatsapp
    group_id_ref: workspace/.config/job-scout.json#whatsapp.group_id
    mode: conversational
tools:
  - browser
  - tavily
  - gmail
  - sheets
  - memory
  - channels.message.send
secrets:
  - TAVILY_API_KEY
  - GOOGLE_OAUTH_TOKEN_DAVIDTUBUL10
workspace_files:
  - workspace/profile/cv.pdf
  - workspace/profile/profile.md
  - workspace/profile/cv-summary.json
  - workspace/.config/job-scout.json
---

# Job-Scout Assistant

You are David Tubul's personal job search assistant. You operate in two modes — autonomous (cron) and conversational (WhatsApp).

## Mode routing

**On invocation, read the first user message and route:**

1. If message is exactly `scout` (from cron) OR `/scout` (from WhatsApp) → load `prompt-scout.md` and execute the daily scout pipeline.
2. Otherwise (any free-form text in WhatsApp) → load `prompt-qa.md` and engage in conversational Q&A.

## Common setup (both modes)

Before doing anything else, load these files into your working context:
- `prompt-scout.md` (if scout mode) or `prompt-qa.md` (if Q&A mode)
- `router.md` (intent rules)
- `sources.json` (search targets)
- `keywords.json` (email status patterns)
- `allowed-locations.json` (city filter)
- `workspace/profile/cv-summary.json` (David's CV summary)
- `workspace/.config/job-scout.json` (group + sheet ids)

## Hard rules (NEVER violate)

1. **Never send WhatsApp messages outside the configured group** (`workspace/.config/job-scout.json#whatsapp.group_id`). All outbound goes there.
2. **Never write to Gmail** — read-only scope. Never reply, label, or modify emails.
3. **Never delete a Sheet row.** Use the Status column ("⛔ Not Interested") to hide. Exception: `/delete N` explicit user command.
4. **Never apply to jobs.** You only surface and track.
5. **Hebrew output to user.** All WhatsApp messages in Hebrew. Internal tool calls in English.
6. **If 0 new jobs AND 0 status changes:** do not send anything in scout mode.
7. **Always cite source URLs** in your messages — David must be able to click through.

## Hard boundaries on tools

| Tool | Allowed actions |
|---|---|
| browser | `fetch`, `screenshot`. No `click`/`type` outside `linkedin.com/jobs/`. |
| gmail | `search`, `get`. Read-only. |
| sheets | `read`, `append`, `update_cells`. No `delete_row` without explicit user command. |
| tavily | `search` only. |
| channels.message.send | Only target = group_id from config. |
| memory | `read`, `write` under namespace `job-scout`. |
SKILLEOF
```

- [ ] **Step 2: Validate frontmatter**
```bash
head -30 ~/.openclaw/agents/main/skills/job-scout/SKILL.md | grep -E "^(name|description|model):"
```
Expected: 3 lines matching `name:`, `description:`, `model:`.

---

### Task 15: Write `prompt-scout.md` (daily scout system prompt)

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/prompt-scout.md`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/prompt-scout.md <<'SCOUTEOF'
# Daily Scout — System Prompt

You are running the daily scout pipeline for David Tubul. Today is {{TODAY}}. Execute every stage. If a stage fails, log the error and continue with the next stage. Send the final message only if there are new jobs OR new status changes.

## Stage 1 — Search

Run **two searches in parallel:**

**A. LinkedIn (browser):**
- For each keyword in `sources.json#linkedin.keywords`:
  - Build URL from `sources.json#linkedin.url_template` substituting `{kw}` (URL-encoded).
  - `browser.fetch(url, persist="linkedin")`
  - Parse job cards from HTML. Each card has: title, company, location, time-posted, jobId.
  - Build canonical URL: `https://www.linkedin.com/jobs/view/<jobId>`
  - Keep only cards with time-posted within last 24 hours.
- Deduplicate within LinkedIn results by jobId.

**B. Tavily web search:**
- For each query in `sources.json#tavily.queries`:
  - `tavily.search(query, time_range="day", max_results=<max>)`
  - Each result has: title, url, content snippet, score.
- Aggregate all Tavily results.

Combine A + B into a single `candidates` list with shape:
```json
{ "source": "linkedin|tavily", "title": "...", "company": "...", "location": "...", "url": "...", "snippet": "...", "posted_at": "..." }
```

## Stage 2 — Location filter

For each candidate:
- Check if `location` contains any string in `allowed-locations.json#allowed.en` or `allowed.he`.
- Check if `location` contains any string in `allowed-locations.json#blocked.*` → exclude.
- Check `remote_handling`: if location says "Remote" without "Israel" → exclude.
- If location is empty or unclear → keep for now (CV match will filter further).

## Stage 3 — CV-match scoring

Load `workspace/profile/cv-summary.json` into context.

For each remaining candidate (batch 5 at a time to limit context):
- For each candidate, you (the LLM) judge:
  - `level`: one of `senior | mid | junior | unknown`
  - `score`: integer 0-100 (how well skills match David's CV — Playwright, Selenium, Cypress, TypeScript, Python, Java, SQL, QA leadership)
  - `reason`: 1-2 sentence Hebrew explanation

Keep candidate if: `level ∈ {senior, mid}` **OR** `score >= 70`.

Output structured intermediate JSON before continuing.

## Stage 4 — Dedupe against Sheet

- Read column A of the Sheet: `sheets.read(sheet_id, range="Jobs!A2:A1000")`
- Each row's column A is the ID hash (sha256 first 12 chars of URL).
- For each candidate, compute `sha256(url)[:12]`.
- Drop candidates whose hash is already in column A.
- Result: `new_candidates`.

## Stage 5 — Gmail status sync (independent of new jobs)

- Compute window: emails from last 48 hours: `gmail.search(query="newer_than:2d", max_results=50)`.
- For each email, fetch body (`gmail.get(message_id)`).
- For each email body, match against `keywords.json` patterns (en + he):
  - If matches `applied` pattern → status="✅ Applied"
  - `interview` → "📞 Interview"
  - `rejected` → "❌ Rejected"
  - `offer` → "🎉 Offer"
- For each matched email, attempt to link to a Sheet row by:
  1. Sender domain matches a company name in column E (fuzzy).
  2. Subject contains a company name in column E (fuzzy).
- If matched: update columns K (status), L (date = today), N (snippet first 100 chars), O (updated = now).
- Track: how many rows updated, by status type.

## Stage 6 — Append new jobs

For each candidate in `new_candidates`:
- Compute ID hash.
- Build row: `[id_hash, today_iso, source, title, company, location, level, score, reason, url, "⏳ Pending", "", "", "", today_iso]`
- `sheets.append(sheet_id, range="Jobs!A:O", values=[row])`

## Stage 7 — Compose WhatsApp message

- If `new_candidates.length == 0` AND `gmail_updates_count == 0`: STOP. Do not send.
- Else, format Hebrew message:

```
🔵 בוקר טוב David! משרות חדשות — {{DD/MM/YYYY}}

📊 סטטוס תיק ההגשות:
✅ הגשת: {applied_count} | 📞 ראיון: {interview_count} | 🎉 הצעה: {offer_count} | ❌ דחייה: {rejected_count} | ⏳ ממתין: {pending_count}

{if gmail_updates_count > 0:}
🔔 עדכוני סטטוס היום:
{for each gmail_update: "  • {company} — {new_status}"}

{if new_candidates.length > 0:}
🆕 {new_candidates.length} משרות חדשות התואמות אותך:

{for each candidate (numbered 1..N):}
{n}. {title}  (score: {score})
   🏢 {company} · 📍 {location}
   💡 {reason}
   🔗 {url}

📋 לטבלה המלאה: https://docs.google.com/spreadsheets/d/{sheet_id}
```

- Counts come from a fresh read of column K (status) on all rows.

## Stage 8 — Send

`channels.message.send(channel="whatsapp", target=<group_id from config>, message=<the composed text>)`

## Stage 9 — Log

Write a JSON file to `workspace/data/runs/{ISO_date}.json` with:
- candidates_total
- after_location_filter
- after_cv_match
- new_appended
- gmail_updates_count
- sent: bool
- errors: []

That's the full pipeline. Execute deterministically. If any tool returns an error, log and continue with the next stage where possible.
SCOUTEOF
```

- [ ] **Step 2: Validate**
```bash
wc -l ~/.openclaw/agents/main/skills/job-scout/prompt-scout.md
grep -c "^## Stage" ~/.openclaw/agents/main/skills/job-scout/prompt-scout.md
```
Expected: ~110 lines and exactly 9 stages.

---

### Task 16: Write `prompt-qa.md` (Q&A system prompt)

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/prompt-qa.md`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/prompt-qa.md <<'QAEOF'
# Conversational Q&A — System Prompt

You are David Tubul's job-search assistant. He is messaging you in the WhatsApp group "Job Scout 🤖". Respond in Hebrew unless he switches to English.

## Available tools (always available — call when needed)

1. `sheets.read(range)` — read rows from the tracker
2. `sheets.update_cells(row, fields)` — update one row by row number (header row = 1, data starts at row 2)
3. `sheets.append(row)` — add a new row manually
4. `gmail.search(query, max=20)` — search Gmail (read-only)
5. `gmail.get(message_id)` — fetch a single email body
6. `tavily.search(query)` — web search (for "what does company X do?")
7. `browser.fetch(url, persist="linkedin")` — fetch a job page

The Sheet is always your source of truth. Read it before answering any question about David's pipeline.

## Intent recognition

Match the user's message to one of these intents:

| Intent | Trigger examples | Action |
|---|---|---|
| **run-scout** | `/scout`, "חפש עכשיו", "scout now" | Switch to `prompt-scout.md` and execute |
| **list-jobs** | "תראה לי משרות", "/list", "מה יש לי" | `sheets.read("A2:O1000")`, format top 10 (or filter by status if requested) |
| **status-summary** | "/status", "מה הסטטוס", "סטטוס" | Count by column K, return Hebrew summary line |
| **mark-applied** | "סמן N הגשתי", "הגשתי N", "N applied" | Update row N+1, column K = "✅ Applied", column L = today, column O = now |
| **mark-status** | "סמן N <status>", "N ראיון/דחייה/הצעה" | Map status word → emoji status, update row |
| **add-note** | "תוסיף הערה ל-N: ...", "N: <note>" | Append/replace column M (notes) on row N+1 |
| **delete-job** | "/delete N", "מחק את N", "תוריד N" | Update column K = "⛔ Not Interested" (do NOT delete row) |
| **add-manual-job** | message contains URL of a job posting | `browser.fetch(url)`, extract title/company, run CV-match, append to Sheet |
| **search-jobs** | "תחפש משרות ב-...", "find jobs in ..." | Use Tavily + apply CV-match to results, present without saving |
| **about-company** | "מה X עושים?", "ספר לי על חברה Y" | Tavily search for company info, summarize in Hebrew |
| **about-gmail** | "מה היה במייל מ-X?", "תראה לי את המייל של Y" | Gmail search for sender/company, summarize matched threads |
| **free-form** | anything else | Conversational reply. May involve combining the above. |

## Output format

- Hebrew, friendly tone (David is a colleague, not a customer).
- Use light emoji to mark items, statuses.
- When listing jobs, format compactly:
  ```
  {row_num}. {title}
     {company} · {location} · {status}
     {url}
  ```
- When user asks for **counts**, lead with the number, then breakdown.
- When user requests an **update**, confirm the change in one short sentence ("עודכן — משרה {N} סומנה כהגשתי").

## Examples

**User:** "לאיזה משרות הגשתי?"
**You:**
1. `sheets.read("A2:O1000")`
2. Filter rows where column K starts with "✅ Applied"
3. Format and reply:
```
✅ הגשת ל-3 משרות עד עכשיו:

1. Senior Automation Engineer @ Wix · 22/05
   https://linkedin.com/jobs/view/123
2. QA Lead @ Monday.com · 24/05
   https://alljobs.co.il/job/456
3. SDET @ Riskified · 25/05
   https://drushim.co.il/job/789
```

**User:** "תסמן את משרה 7 כהגשתי"
**You:**
1. `sheets.update_cells(row=8, K="✅ Applied", L=today, O=now)` (row 8 because header at row 1, jobs start row 2; job #7 = row 8)
2. Reply: "✓ עודכן — משרה 7 (Senior QA @ Lemonade) סומנה כהגשתי. ${today}"

**User:** "מה הסטטוס?"
**You:**
1. Read all rows, count by K.
2. Reply:
```
📊 סטטוס תיק:
✅ הגשת: 12 | 📞 ראיון: 2 | 🎉 הצעה: 0 | ❌ דחייה: 3 | ⏳ ממתין: 8 | ⛔ לא רלוונטי: 4
סה״כ: 29 משרות במעקב
```

## Hard rules (repeated from SKILL.md)

- Never send messages outside the configured WhatsApp group.
- Never modify Gmail.
- Never delete Sheet rows without explicit `/delete N` from user (and even then, prefer status="⛔ Not Interested").
- Hebrew responses by default; mirror English if user writes in English.
- If a request is ambiguous, ask a single short clarifying question instead of guessing.
QAEOF
```

- [ ] **Step 2: Validate**
```bash
grep -c "^| \*\*" ~/.openclaw/agents/main/skills/job-scout/prompt-qa.md
```
Expected: 12 (one per intent row in the table).

---

### Task 17: Write `router.md` (intent routing rules)

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/router.md`

- [ ] **Step 1: Write the file**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/router.md <<'ROUTEREOF'
# Intent Router

This document is a quick-reference table used by both `prompt-scout.md` and `prompt-qa.md` to interpret David's incoming WhatsApp messages.

## Command prefixes (exact match)

| Input | Intent |
|---|---|
| `/scout` | run-scout |
| `/status` | status-summary |
| `/list` | list-jobs |
| `/list applied` | list-jobs filtered by status |
| `/list pending` | same, status=pending |
| `/list interview` | same |
| `/help` | reply with this table summarized |
| `/delete N` | delete-job (sets status to ⛔ Not Interested) |

## Natural-language patterns

| Hebrew/English regex | Intent |
|---|---|
| `(?i)^(scout( now)?|חפש( עכשיו)?)$` | run-scout |
| `(?i)(סטטוס|status|מה היה|מצב( המשרות)?)$` | status-summary |
| `(?i)(תראה לי|הראה|list|show me) (משרות|jobs)` | list-jobs |
| `(?i)לאיזה משרות הגשתי` | list-jobs (status=applied) |
| `^\d+ ?:?(הגשתי|applied)$` | mark-applied (number = job row idx) |
| `^הגשתי (ל)?(משרה )?\d+$` | mark-applied |
| `(?i)^סמן (משרה )?\d+ (כ)?(הגשתי|ראיון|דחייה|דחו אותי|הצעה|לא רלוונטי)$` | mark-status |
| `^https?://(www\.)?(linkedin\.com|alljobs\.co\.il|jobmaster\.co\.il|drushim\.co\.il|indeed\.com|glassdoor\.com)` | add-manual-job (URL detected) |
| `(?i)(מה|what|ספר לי) .{1,80} (עושים|do|company)` | about-company |

If none match → free-form (use prompt-qa.md examples).

## Status word map

| User input | Stored as |
|---|---|
| `הגשתי` / `applied` | `✅ Applied` |
| `ראיון` / `interview` | `📞 Interview` |
| `דחייה` / `דחו אותי` / `rejected` | `❌ Rejected` |
| `הצעה` / `offer` | `🎉 Offer` |
| `לא רלוונטי` / `not interested` | `⛔ Not Interested` |
| `ממתין` / `pending` | `⏳ Pending` (default for new) |

## Row number convention

User-facing job index = row_number_in_sheet - 1.
Example: row 5 in the sheet = job #4 for the user.
This is because row 1 is the header.
ROUTEREOF
```

- [ ] **Step 2: Validate**
```bash
grep -c "^| " ~/.openclaw/agents/main/skills/job-scout/router.md
```
Expected: >= 20 lines starting with table separators.

---

### Task 18: Write tool guides under `tools/`  `[parallel-safe: each tool guide is independent]`

**Files:**
- Create: `~/.openclaw/agents/main/skills/job-scout/tools/linkedin-search.md`
- Create: `~/.openclaw/agents/main/skills/job-scout/tools/tavily-search.md`
- Create: `~/.openclaw/agents/main/skills/job-scout/tools/cv-match.md`
- Create: `~/.openclaw/agents/main/skills/job-scout/tools/gmail-classify.md`
- Create: `~/.openclaw/agents/main/skills/job-scout/tools/sheets-rw.md`

- [ ] **Step 1: linkedin-search.md**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/tools/linkedin-search.md <<'LSEOF'
# LinkedIn search via browser

## Tool call
```
browser.fetch(url, persist="linkedin", timeout_ms=15000)
```

## URL construction
Base template: `https://www.linkedin.com/jobs/search/?keywords={kw}&location=Israel&f_TPR=r86400&f_E=3%2C4&sortBy=DD`

- `{kw}`: URL-encode (e.g., "Senior Automation" → `Senior%20Automation`)
- `f_TPR=r86400` = last 24h
- `f_E=3,4` = Associate + Mid-Senior level
- `sortBy=DD` = Date descending

## HTML parsing
Each job card matches CSS selector `.job-card-container`. Within each:
- title: `.job-card-list__title` text
- company: `.job-card-container__company-name` text
- location: `.job-card-container__metadata-item` first text
- time-posted: `time` element's `datetime` attribute
- jobId: the URL fragment after `/jobs/view/` (or the `data-job-id` attribute)

If LinkedIn shows a captcha (page contains "Please complete the captcha"), log error `linkedin_captcha`, skip stage A, continue with Tavily.

## Canonical URL
`https://www.linkedin.com/jobs/view/{jobId}` — always use this, not the click-redirect URL.

## Output schema (per job)
```json
{
  "source": "linkedin",
  "title": "...",
  "company": "...",
  "location": "...",
  "url": "https://www.linkedin.com/jobs/view/...",
  "posted_at": "ISO timestamp",
  "snippet": null
}
```
LSEOF
```

- [ ] **Step 2: tavily-search.md**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/tools/tavily-search.md <<'TSEOF'
# Tavily web search

## Tool call
```
tavily.search(query, time_range="day", search_depth="basic", max_results=N)
```

## Result schema
Each result:
- title: str
- url: str
- content: str (snippet)
- score: float (Tavily's relevance score)

## Filtering
- Drop results where `score < 0.5`.
- Drop results where url domain is NOT one of: alljobs.co.il, jobmaster.co.il, drushim.co.il, indeed.com, glassdoor.com, linkedin.com (avoid blog posts/articles).

## Output schema (mapped)
```json
{
  "source": "tavily",
  "title": "<from result.title>",
  "company": "<extract from title or content; if absent, null>",
  "location": "<extract from content; if absent, null>",
  "url": "<result.url>",
  "posted_at": null,
  "snippet": "<first 200 chars of result.content>"
}
```

## Company/location extraction heuristic
If title contains "at <X>" or "@ <X>" → company = X.
If content contains city name from `allowed-locations.json` → location = that city.
Otherwise leave as null and let CV-match still run (score will downgrade items without clear info).
TSEOF
```

- [ ] **Step 3: cv-match.md**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/tools/cv-match.md <<'CMEOF'
# CV-match scoring

## Input
- Candidate: `{title, company, location, url, snippet}`
- David's CV summary (from `workspace/profile/cv-summary.json`)

## Scoring procedure

You (the LLM) read both and output for each candidate:

```json
{
  "level": "senior | mid | junior | unknown",
  "score": 0-100,
  "reason": "Hebrew, 1-2 sentences"
}
```

## Level determination
- Title contains `senior|lead|principal|staff|סניור|Lead|Head` → `senior`
- Title contains `mid|intermediate` OR `3-5 years` in description → `mid`
- Title contains `junior|entry|new grad|0-2 years|graduate` → `junior`
- Otherwise → `unknown`

## Score rubric (0-100)
Start at 50. Add points:
- Title contains "QA" or "Automation" or "SDET" or "Test": +20
- Snippet/title mentions Playwright, Selenium, Cypress: +10 each (max +20)
- Snippet mentions TypeScript, Python, Java: +5 each (max +15)
- Title contains "Lead" or "Head" and David's CV says "Team Lead" / "Head of QA": +10
- Snippet mentions Agile, CI/CD, ETL: +5
- Subtract:
  - Title strongly suggests non-QA (e.g., "Frontend Developer", "Data Analyst"): -30
  - Junior/Intern: -40
  - Junior years required (0-2y) explicit: -25

Clamp 0-100.

## Reason format
Hebrew, max 2 sentences. Mention 1-2 specific match points.
Example: "התאמה גבוהה — Playwright + TypeScript, 5+ שנות ניסיון. החברה במרכז."

## Keep/drop decision (caller's responsibility, not yours)
Caller keeps if: `level ∈ {senior, mid}` OR `score >= 70`.
CMEOF
```

- [ ] **Step 4: gmail-classify.md**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/tools/gmail-classify.md <<'GCEOF'
# Gmail classification

## Search

```
gmail.search(query="newer_than:2d -from:noreply@linkedin.com -subject:digest", max_results=50)
```

The exclusions prune LinkedIn's own job-alert spam.

## Per-email processing

For each message_id in results:
1. `gmail.get(message_id)` → returns `{from, subject, snippet, body_text, date}`
2. Concat `subject + " " + body_text[:2000]` → search string.
3. Test against `keywords.json` patterns (en + he) in order: `offer > interview > rejected > applied > noise`.
4. First match wins. If only `noise` matches → skip.
5. If no match → status = `unknown`, do nothing.

## Company linking

From the email's `from` field, extract domain. From subject + body, extract any proper noun resembling a company name.

For each Sheet row (read column E = company):
- If domain second-level (`example.com` → `example`) fuzzy-matches column E (Levenshtein distance ≤ 2 on lowercased) → **match**.
- Else if subject contains column E text (case-insensitive substring) → **match**.

If exactly 1 row matches → update it.
If 0 rows match → log "unlinked email" but skip.
If 2+ rows match → pick the most recent (earliest column B = "Date Found").

## Update format

When updating Sheet row N:
- column K = new status emoji ("✅ Applied" / "📞 Interview" / etc.)
- column L = email's `date` (ISO date only)
- column N = email snippet first 100 chars
- column O = now (ISO datetime)
- Append to column M (notes) if not empty: ` | <date>: <status from email>`

## Output

For the daily scout caller, return:
```json
{
  "matched": [{"row": N, "old_status": "...", "new_status": "...", "company": "...", "email_subject": "..."}],
  "unlinked": [{"from": "...", "subject": "...", "matched_status": "..."}]
}
```
GCEOF
```

- [ ] **Step 5: sheets-rw.md**
```bash
cat > ~/.openclaw/agents/main/skills/job-scout/tools/sheets-rw.md <<'SREOF'
# Google Sheets read/write

## Read

```
sheets.read(sheet_id, range="Jobs!A2:O1000")
```

Returns a 2D array. Row indices start at 0 here, but in user-facing references the row number is the Sheets row (header at 1, jobs at 2+).

## Append

```
sheets.append(sheet_id, range="Jobs!A:O", values=[[col_a, col_b, ..., col_o]])
```

## Update single row

```
sheets.update_cells(sheet_id, range="Jobs!K{row}:O{row}", values=[[status, applied_date, notes_append, email_snippet, updated_now]])
```

Where `{row}` is the actual sheet row number (e.g., row 8 = job #7 for the user).

## Column reference

| Col | Index | Header |
|---|---|---|
| A | 0 | ID (sha256[:12] of URL) |
| B | 1 | תאריך מציאה |
| C | 2 | מקור |
| D | 3 | תפקיד |
| E | 4 | חברה |
| F | 5 | מיקום |
| G | 6 | רמה |
| H | 7 | ציון התאמה |
| I | 8 | נימוק |
| J | 9 | קישור |
| K | 10 | סטטוס |
| L | 11 | תאריך הגשה |
| M | 12 | הערות |
| N | 13 | זוהה ממייל |
| O | 14 | עודכן |

## Status values (column K)

Exactly one of: `⏳ Pending`, `✅ Applied`, `📞 Interview`, `🎉 Offer`, `❌ Rejected`, `⛔ Not Interested`.
Default for newly-found jobs: `⏳ Pending`.

## ID computation

```
import hashlib
hashlib.sha256(url.encode()).hexdigest()[:12]
```

(In the agent's environment, use any sha256 utility; the agent has shell access via `bash` if needed. Or compute via JS: `crypto.createHash('sha256').update(url).digest('hex').slice(0,12)`.)
SREOF
```

- [ ] **Step 6: Verify all 5 files exist**
```bash
ls -la ~/.openclaw/agents/main/skills/job-scout/tools/
```
Expected: 5 .md files, each 1-3 KB.

---

# Phase 4 — Wire It Up

### Task 19: Install / register the skill

**Files:** none (uses CLI)

- [ ] **Step 1: Register the skill**
```bash
~/open_claw/openclaw skills install ~/.openclaw/agents/main/skills/job-scout
```
Expected: `Installed skill: job-scout v1.0.0`

- [ ] **Step 2: Verify**
```bash
~/open_claw/openclaw skills list 2>&1 | grep job-scout
```
Expected: `job-scout  1.0.0  enabled`

- [ ] **Step 3: Check skill is ready**
```bash
~/open_claw/openclaw skills check job-scout
```
Expected: all checks pass. If any fail (missing secrets, plugins, etc.) — fix and re-run.

---

### Task 20: Create the daily cron job

**Files:** none (cron stored in OpenClaw state)

- [ ] **Step 1: Create cron**
```bash
~/open_claw/openclaw cron add \
  --name "job-scout-daily" \
  --schedule "0 9 * * *" \
  --timezone "Asia/Jerusalem" \
  --skill job-scout \
  --prompt "scout" \
  --enabled false
```
**Note:** `--enabled false` — we don't enable until Phase 5 validation passes.

- [ ] **Step 2: Verify**
```bash
~/open_claw/openclaw cron list 2>&1
```
Expected: row `job-scout-daily  0 9 * * *  Asia/Jerusalem  job-scout  disabled`

---

### Task 21: Configure WhatsApp inbound routing to the skill

**Files:**
- Modify: `~/.openclaw/openclaw.json` (channel routing)

- [ ] **Step 1: Get the group_id**
```bash
GROUP_ID=$(jq -r .whatsapp.group_id ~/open_claw/workspace/.config/job-scout.json)
echo "Routing inbound from $GROUP_ID to skill job-scout"
```

- [ ] **Step 2: Add routing rule**
```bash
~/open_claw/openclaw channels route add \
  --channel whatsapp \
  --filter "chat=$GROUP_ID" \
  --skill job-scout \
  --mode conversational
```
Expected: `Route added: whatsapp[chat=$GROUP_ID] → skill:job-scout (conversational)`

- [ ] **Step 3: Verify**
```bash
~/open_claw/openclaw channels route list
```
Expected: at least one route showing the group → job-scout binding.

---

# Phase 5 — Validation (dry-run before enabling)

### Task 22: Dry-run search stages 1+2 (location filter) only

**Files:**
- Read: skill files

- [ ] **Step 1: Invoke skill in dry-run mode**
```bash
~/open_claw/openclaw agent \
  --skill job-scout \
  --message "scout DRY_RUN_STAGES=1,2 NO_SEND=true" \
  --output /tmp/dryrun-1-2.json
```

- [ ] **Step 2: Inspect output**
```bash
jq '.candidates | length' /tmp/dryrun-1-2.json
jq '.after_location_filter | length' /tmp/dryrun-1-2.json
jq '.errors' /tmp/dryrun-1-2.json
```
Expected: candidates > 5, after_location_filter > 0, errors is `[]` or contains only `linkedin_captcha`.

- [ ] **Step 3: Manual review**
Open `/tmp/dryrun-1-2.json`. Sample 5 locations from `after_location_filter` — verify all are in the allowed list. If any blocked city slipped through, the location filter needs work (likely whitespace/case issue) — fix in `allowed-locations.json` and re-run.

---

### Task 23: Dry-run CV-match against 3 known candidates

**Files:**
- Create: `/tmp/test-candidates.json`

- [ ] **Step 1: Construct test candidates**
```bash
cat > /tmp/test-candidates.json <<'EOF'
[
  {"source":"test","title":"Senior QA Automation Engineer","company":"Wix","location":"Tel Aviv","url":"https://example.com/1","snippet":"5+ years Playwright TypeScript experience required, lead QA team"},
  {"source":"test","title":"Junior Frontend Developer","company":"Foo","location":"Tel Aviv","url":"https://example.com/2","snippet":"React, JavaScript, 0-2 years"},
  {"source":"test","title":"Automation Engineer (Mid-level)","company":"Riskified","location":"Tel Aviv","url":"https://example.com/3","snippet":"Selenium, Cypress, Python, 3-5 years"}
]
EOF
```

- [ ] **Step 2: Run CV-match only**
```bash
~/open_claw/openclaw agent \
  --skill job-scout \
  --message "cv-match-only INPUT=/tmp/test-candidates.json" \
  --output /tmp/dryrun-cv-match.json
```

- [ ] **Step 3: Verify expected scores**
```bash
jq '.[] | {title, level, score, kept: (.level == "senior" or .level == "mid" or .score >= 70)}' /tmp/dryrun-cv-match.json
```
Expected:
- Senior QA Automation: level=senior, score >= 85, kept=true
- Junior Frontend: level=junior, score <= 30, kept=false
- Mid Automation: level=mid, score >= 70, kept=true

If any expectation fails, tune `cv-match.md` rubric and re-run.

---

### Task 24: Dry-run Gmail classification on real inbox

**Files:** none (read-only)

- [ ] **Step 1: Invoke just the Gmail stage**
```bash
~/open_claw/openclaw agent \
  --skill job-scout \
  --message "gmail-only DAYS=14" \
  --output /tmp/dryrun-gmail.json
```

- [ ] **Step 2: Inspect**
```bash
jq '.matched | length, .unlinked | length' /tmp/dryrun-gmail.json
jq '.matched[] | {subject: .email_subject, status: .new_status, company: .company}' /tmp/dryrun-gmail.json
```
Expected: at least some matched emails if David has interacted with jobs in past 14 days. Each match has plausible status.

- [ ] **Step 3: Manual review**
Confirm classifications look right. Sheet is NOT updated in this dry-run (NO_SEND).

---

### Task 25: Dry-run Sheets append (write 1 fake job)

**Files:**
- Modify: Google Sheet "Jobs" tab (test row)

- [ ] **Step 1: Append a test row**
```bash
SHEET_ID=$(jq -r .google.sheet_id ~/open_claw/workspace/.config/job-scout.json)
~/open_claw/openclaw infer sheets update \
  --sheet-id "$SHEET_ID" \
  --range "Jobs!A:O" \
  --append \
  --values '[["test123","2026-05-26","test","Senior QA Test","TestCo","Tel Aviv","senior",85,"בדיקת מערכת","https://example.com/test","⏳ Pending","","","",""]]'
```

- [ ] **Step 2: Verify in browser**
Open `https://docs.google.com/spreadsheets/d/$SHEET_ID/edit`. Confirm new row appeared with all 15 columns populated, Hebrew text rendered RTL correctly.

- [ ] **Step 3: Clean up test row**
Delete the test row manually in the browser (right-click → Delete row). Or use:
```bash
~/open_claw/openclaw infer sheets delete-row --sheet-id "$SHEET_ID" --row 2
```

---

### Task 26: WhatsApp group send + receive test

**Files:** none

- [ ] **Step 1: Send a test message to the group**
```bash
GROUP_ID=$(jq -r .whatsapp.group_id ~/open_claw/workspace/.config/job-scout.json)
~/open_claw/openclaw message send \
  --channel whatsapp \
  --target "$GROUP_ID" \
  --message "🤖 Job Scout test: this is a connectivity check."
```
Expected: message appears in the WhatsApp group within 5 seconds.

- [ ] **Step 2: User sends a reply in the group**
On phone: in the "Job Scout 🤖" group, send `/status`.

- [ ] **Step 3: Verify the skill received the message**
```bash
~/open_claw/openclaw logs --tail 100 2>&1 | grep -i "job-scout\|/status"
```
Expected: log lines showing the skill received `/status` and started processing.

- [ ] **Step 4: Verify reply arrives in the group**
On phone: confirm the agent replied with a status summary (will be all zeros initially — Sheet is empty).

---

### Task 27: Full end-to-end dry-run (no automatic send)

**Files:** none

- [ ] **Step 1: Run full scout but suppress send**
```bash
~/open_claw/openclaw agent \
  --skill job-scout \
  --message "scout NO_SEND=true" \
  --output /tmp/dryrun-full.json \
  --timeout 600
```
This runs all 9 stages but stops at Stage 8 (send).

- [ ] **Step 2: Inspect run summary**
```bash
jq '{candidates_total, after_location_filter, after_cv_match, new_appended, gmail_updates_count, sent, errors}' /tmp/dryrun-full.json
```
Expected:
- candidates_total: 20-80
- after_location_filter: 5-30
- after_cv_match: 1-15
- new_appended: same as after_cv_match (first run, Sheet empty)
- sent: false (NO_SEND=true)
- errors: empty or only `linkedin_captcha`

- [ ] **Step 3: Inspect what would have been sent**
```bash
jq -r '.message_preview' /tmp/dryrun-full.json
```
Expected: Hebrew message with job list and stats. **Review manually.**

- [ ] **Step 4: Verify Sheet was populated**
Open the Sheet in browser. Confirm jobs from `after_cv_match` appear with all 15 columns.

- [ ] **Step 5: If everything looks good, commit the workspace config**
The skill and configs are now stable.

---

### Task 28: First live run (send to group)

**Files:** none

- [ ] **Step 1: Manual trigger with live send**
```bash
~/open_claw/openclaw agent \
  --skill job-scout \
  --message "scout" \
  --timeout 600
```

- [ ] **Step 2: Check WhatsApp group**
The agent should send the daily message to the "Job Scout 🤖" group.

- [ ] **Step 3: Verify Sheet was updated**
Reopen the Sheet — rows from Task 27 are still there (no duplicates due to dedupe). If a new run found new jobs, they're appended.

---

### Task 29: Enable the cron

**Files:** none

- [ ] **Step 1: Enable**
```bash
~/open_claw/openclaw cron enable job-scout-daily
```
Expected: `Cron enabled: job-scout-daily`

- [ ] **Step 2: Verify next run time**
```bash
~/open_claw/openclaw cron list 2>&1 | grep job-scout-daily
```
Expected: shows `enabled` and a "next run" of tomorrow 09:00 Asia/Jerusalem.

---

### Task 30: Monitor first overnight cron run

**Files:** none

- [ ] **Step 1: Day +1 morning — check WhatsApp at 09:05**
Open the "Job Scout 🤖" group on phone. Expect a fresh daily message.

- [ ] **Step 2: Check logs**
```bash
~/open_claw/openclaw logs --since 12h 2>&1 | grep -E "job-scout|cron"
```
Expected: log entries showing cron fired at 09:00 and skill ran successfully.

- [ ] **Step 3: Check run log file**
```bash
ls -la ~/open_claw/workspace/data/runs/ | tail -5
```
Expected: a file `2026-05-27.json` (or next day) with full run summary.

- [ ] **Step 4: Spot-check the Sheet**
Verify 3-5 jobs from the morning message appear in the Sheet with status ⏳ Pending.

- [ ] **Step 5: Apply to a real job in the group**
Send in the group: `סמן 1 הגשתי` (or `/apply 1`).
Expected: agent confirms, Sheet row updates within 10 seconds.

---

## Done criteria

The implementation is complete when:
- ✅ All 30 tasks marked done
- ✅ Task 30 shows daily messages arriving at 09:00 for 3 consecutive days
- ✅ Sheet has at least 20 rows after first week
- ✅ Status updates from Gmail work (verified by manually applying to a job and waiting for the confirmation email)
- ✅ Q&A mode answers basic questions correctly (`/status`, `/list`, `מה הסטטוס`, etc.)

## Rollback

If something goes badly wrong:

```bash
# Disable cron
~/open_claw/openclaw cron disable job-scout-daily
# Remove inbound routing
~/open_claw/openclaw channels route remove --channel whatsapp --filter "chat=$GROUP_ID"
# Skill still exists but no longer runs
```

To fully remove:
```bash
~/open_claw/openclaw cron remove job-scout-daily
~/open_claw/openclaw skills uninstall job-scout
rm -rf ~/.openclaw/agents/main/skills/job-scout
rm -rf ~/open_claw/workspace/.config ~/open_claw/workspace/data
# Sheet remains in your Drive — delete manually if desired.
```

---

## Parallel execution map

For subagent-driven execution, these task groups can run concurrently (no shared mutable state until merge):

**Group A — Pre-flight (after Task 1):** Tasks 2, 3, 4, 6, 7 in parallel (Task 5 depends on 4).
**Group B — Skill content (after Phase 1+2):** Tasks 11, 12, 13, 14 in parallel (independent files). Task 18's 5 sub-files can run in parallel within Group B.
**Group C — Validation:** Tasks 22, 23, 24, 25 can run in parallel (independent verifications). Tasks 26, 27, 28 must run sequentially.

Recommendation: dispatch Group B (skill construction) as 4 parallel subagents — they're pure file writes with no overlap. Validation tasks 22-25 can also run as 4 parallel subagents.
