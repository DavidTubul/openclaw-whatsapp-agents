# סוכן משרות סניור+מידל אוטומציה — Design Spec v3 (conversational)

**תאריך:** 2026-05-26
**Owner:** David Tubul (owner@example.com)
**פלטפורמה:** OpenClaw 2026.5.22 (Gateway daemon מותקן ורץ כ-systemd user)

## 1. מטרה

סוכן OpenClaw **דו-כיווני** (Job-Scout Assistant) שמשלב 3 modes:

**Mode 1 — Daily Scout (09:00 Asia/Jerusalem):**
1. סורק LinkedIn ומקורות נוספים למשרות **QA Automation / Automation Engineer**, רמת **Senior + Mid + משרות כלליות שמתאימות לפי הקורות חיים**.
2. שולח הודעת WhatsApp עם משרות חדשות + סטטוס מעקב ההגשות.
3. סורק את ה-Gmail כדי לזהות אישורי הגשה / זימוני ראיון / דחיות, ומעדכן סטטוס אוטומטית.

**Mode 2 — Manual Trigger:**
- WhatsApp command: `/scout` (או "חפש עכשיו") → ריצת חיפוש מיידית
- CLI: `openclaw agent --skill job-scout --message "scout"` → ריצה מהטרמינל
- Dashboard button: כפתור "Run now"

**Mode 3 — Conversational Q&A (WhatsApp chat):**
- שיחה חופשית בעברית או אנגלית מול הסוכן ב-WhatsApp
- דוגמאות לשאלות:
  - "לאיזה משרות הגשתי השבוע?"
  - "מה הסטטוס של ההגשה לוויקס?"
  - "כמה משרות עם match מעל 80?"
  - "תראה לי משרות שעוד לא הגשתי אליהן"
  - "מתי הראיון הבא שלי?"
- דוגמאות לפעולות:
  - "סמן את משרה 7 כהגשתי"
  - "תוסיף הערה למשרה במונדיי: 'חיכיתי לתשובה שלהם'"
  - "שנה את הסטטוס של משרה 3 לראיון, ב-29/05 ב-14:00"
  - "תוריד את משרה 12 — לא רלוונטית"

**Mode 4 — Single source of truth:**
כל המעקב ב-Google Sheets — אתה יכול לערוך ידנית, הסוכן יכול לערוך, השניים נשארים sync.

## 2. דרישות

### פונקציונליות

#### חיפוש משרות
- **רמות תפקיד:** Senior + Mid (גם משרות "כלליות" עם match >= 70/100 ל-CV)
- **תפקידים:** QA / Test Automation (primary), Automation Engineer, RPA, DevOps Automation, SDET, Backend Automation
- **מיקום:** מרכז + ערים נגישות ממודיעין (היבריד OK, Remote-IL OK)
  - **כלולה:** Tel Aviv, Ramat Gan, Givatayim, Bnei Brak, Holon, Bat Yam, Rishon LeZion, Rehovot, Ness Ziona, Lod, Ramla, Modi'in, Herzliya
  - **גם בעברית:** תל אביב, רמת גן, גבעתיים, בני ברק, חולון, בת ים, ראשון לציון, רחובות, נס ציונה, לוד, רמלה, מודיעין, הרצליה
  - **לא כלולה:** Jerusalem/ירושלים, Petah Tikva/פתח תקווה, Netanya/נתניה, Haifa/חיפה, North, South, Galilee, Rosh HaAyin/ראש העין
  - **Remote גלובלי:** דחה. Remote-IL בלבד אם בכלל.
- **תדירות:** יומי 09:00 Asia/Jerusalem
- **מקורות:** LinkedIn (browser logged-in), Tavily web search על AllJobs / JobMaster / Drushim / Indeed / Glassdoor / JobInfo

#### CV-aware matching
- LLM קורא את ה-CV (`workspace/profile/cv.pdf`) פעם אחת ב-startup, מחלץ skills/experience וסוכם
- לכל משרה candidate: LLM מקבל את ה-job description + ה-CV summary, מוציא:
  - `level`: senior / mid / junior / unknown
  - `score`: 0-100 (התאמת skills/experience)
  - `reason`: 1-2 משפטים בעברית
- כלולה אם: `level ∈ {senior, mid}` **או** `score >= 70`

#### Gmail tracking
- חשבון: **owner@example.com** (OAuth, scope: read-only)
- סריקה יומית של inbox + spam מ-48 שעות אחרונות (overlap לבטיחות)
- זיהוי אוטומטי לפי תבניות בעברית ואנגלית:
  | סוג | תבניות (regex/keywords) |
  |---|---|
  | **applied** | "thank you for applying", "application received", "תודה על הגשתך", "קיבלנו את מועמדותך" |
  | **interview** | "interview", "schedule a call", "phone screen", "ראיון", "שיחת היכרות" |
  | **rejected** | "unfortunately", "we regret", "moving forward with other candidates", "לצערנו", "החלטנו לא להמשיך" |
  | **offer** | "pleased to offer", "offer letter", "אנו שמחים להציע" |
- ההתאמה למשרה ב-Sheets: לפי **דומיין שולח** + **שם חברה** (fuzzy match)

#### Manual triggers
| דרך | פקודה | תיאור |
|---|---|---|
| WhatsApp | `/scout` או "חפש משרות עכשיו" | ריצת scan מיידית |
| CLI | `openclaw agent --skill job-scout --message scout` | מהטרמינל |
| CLI | `openclaw chat` | TUI אינטראקטיבי |
| Dashboard | כפתור "Run now" ב-127.0.0.1:18789 | UI |

#### Conversational Q&A — tools זמינים לסוכן
- `sheet.read(query?)` — שלוף שורות מ-Sheet עם/בלי פילטר
- `sheet.update(row_id, fields)` — עדכן שורה
- `sheet.append(job)` — הוסף משרה חדשה
- `sheet.delete(row_id)` — מחק שורה
- `gmail.search(query, days?)` — חיפוש מיילים (read-only)
- `gmail.get(message_id)` — תוכן מייל מלא
- `memory.recent_jobs(days)` — משרות מ-N ימים אחרונים
- `web.search(query)` — Tavily חיפוש (לשאלות "מה החברה X עושה?")
- `browser.fetch(url)` — קרא דף משרה ספציפי

#### Google Sheets tracking
- Sheet אחד: **"Job Search Tracker — David Tubul"**
- חברה ב-Google Drive שלך (`owner@example.com`)
- עמודות (העברית בכותרות):
  | # | עמודה | תוכן |
  |---|---|---|
  | A | ID | hash קצר של ה-URL |
  | B | תאריך מציאה | datetime ISO |
  | C | מקור | LinkedIn / AllJobs / ... |
  | D | תפקיד | Senior QA Automation Engineer |
  | E | חברה | Wix |
  | F | מיקום | Tel Aviv (Hybrid) |
  | G | רמה | senior / mid |
  | H | ציון התאמה | 0-100 |
  | I | נימוק | "match לפי Playwright, TypeScript, 5y+ exp" |
  | J | קישור | URL |
  | K | סטטוס | ⏳ Pending / ✅ Applied / 📞 Interview / 🎉 Offer / ❌ Rejected / ⛔ Not Interested |
  | L | תאריך הגשה | (מתעדכן מ-Gmail) |
  | M | הערות | text חופשי |
  | N | זוהה מ-Email | snippet אחרון מ-Gmail שעדכן את הסטטוס |
  | O | עודכן | datetime ISO |

#### WhatsApp — דו-כיווני בקבוצה ייעודית
- ערוץ: WhatsApp Web (paired one-time via QR לחשבון 050-000-0000 שלך)
- **יעד outbound + inbound:** קבוצת WhatsApp ייעודית בשם **"Job Scout 🤖"**
  - אתה יוצר את הקבוצה (one-time setup)
  - הסוכן רץ על המספר שלך → שולח/קורא מתוך הקבוצה כ-"David"
  - שיחה ב-Self-DM נשארת חופשית לך
- **יצירת הקבוצה:**
  - אופציה 1 (פשוטה): צור קבוצה עם איש קשר אחד placeholder → אחרי יצירה הסר אותו → נשארת קבוצת יחיד
  - אופציה 2: WhatsApp עדכני (2024+) מאפשר solo group ישירות
  - הסוכן ב-bootstrap שואל אותך לשם הקבוצה ומאתר את ה-chat ID אוטומטית
- intent routing על הודעות בקבוצה:
  - מתחיל ב-`/` → command (`/scout`, `/status`, `/list`, `/help`)
  - מכיל URL של משרה → "add this job manually"
  - מספר + מילה כמו "הגשתי" → "update job N status"
  - אחר → free Q&A (LLM משתמש ב-tools של Sheets/Gmail)
- **חוק חשוב:** הסוכן לעולם לא שולח הודעות מחוץ לקבוצה (לא לאנשי קשר אחרים שלך).
- פורמט הודעה יומית:

```
🔵 בוקר טוב David! משרות חדשות — 26/05/2026

📊 סטטוס תיק ההגשות:
✅ הגשת: 12 | 📞 ראיון: 2 | 🎉 הצעה: 0 | ❌ דחייה: 3 | ⏳ ממתין: 8

🆕 5 משרות חדשות התואמות אותך:

1. Senior QA Automation Engineer  (score: 92)
   🏢 Wix · 📍 Tel Aviv (Hybrid)
   💡 התאמה: Playwright + TypeScript + 5y+
   🔗 https://linkedin.com/jobs/view/...

2. ...

📋 לטבלה המלאה: https://docs.google.com/spreadsheets/d/...
```

- אם 0 משרות חדשות **ו**אין שינויי סטטוס: לא לשלוח (להימנע מספאם)
- אם 0 משרות חדשות **אבל** יש שינויי סטטוס (למשל זוהה אישור הגשה): שלח עדכון סטטוס בלבד

### לא-פונקציונליות
- **עלות:** **0$ נוסף**. הסוכן רץ על המנוי הקיים של Claude (`agentRuntime: claude-cli` ב-config) — קריאות ה-LLM נחשבות במסגרת המנוי, לא בחיוב API. Tavily/Gmail/Sheets/Drive — חינמי. שימוש יומי צפוי: ~90K tokens (~1% מהמכסה היומית).
- **Rate limit fallback:** אם הגעת למכסה, ה-skill יכול לעבור אוטומטית ל-Sonnet 4.6 או Haiku 4.5 (זול יותר ב-quota). מוגדר ב-`models.fallbacks` של OpenClaw.
- **פרטיות:** הכל לוקאלי; Gmail OAuth read-only; Sheets בחשבון שלך.
- **רובסטיות:** כשל במקור אחד → המשך עם הנותרים; כשל Gmail → רק חיפוש בלי עדכון סטטוסים.

## 3. ארכיטקטורה

```
┌─────────────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway (systemd user, running)                           │
│                                                                     │
│  ┌─────────────┐                                                    │
│  │ Cron        │  daily 09:00 Asia/Jerusalem                        │
│  │ "job-scout" │                                                    │
│  └──────┬──────┘                                                    │
│         │                                                           │
│         ▼                                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Agent (claude-opus-4-7 via anthropic-cli)                     │  │
│  │  Skill: job-scout                                             │  │
│  │                                                               │  │
│  │  Stage 1: Search                                              │  │
│  │   • browser → LinkedIn (logged in, posted last 24h)           │  │
│  │   • tavily  → AllJobs/JobMaster/Drushim/Indeed/Glassdoor      │  │
│  │                                                               │  │
│  │  Stage 2: Match (CV-aware)                                    │  │
│  │   • Load profile: workspace/profile/cv.pdf + profile.md       │  │
│  │   • For each job → LLM: level, score, reason                  │  │
│  │   • Keep if level ∈ {senior,mid} OR score >= 70               │  │
│  │                                                               │  │
│  │  Stage 3: Dedupe                                              │  │
│  │   • Read existing Sheet (column A: ID hashes)                 │  │
│  │   • Skip any URL hash that already exists                     │  │
│  │                                                               │  │
│  │  Stage 4: Email tracking                                      │  │
│  │   • google plugin → Gmail API (read-only, scope:              │  │
│  │     https://www.googleapis.com/auth/gmail.readonly)           │  │
│  │   • Fetch unread + threads from last 48h                      │  │
│  │   • Classify each email → applied/interview/rejected/offer    │  │
│  │   • Match to Sheet rows by company name + sender domain       │  │
│  │   • Update column K (status), L (date), N (snippet), O        │  │
│  │                                                               │  │
│  │  Stage 5: Output                                              │  │
│  │   • Append new jobs to Sheet                                  │  │
│  │   • Format Hebrew WhatsApp message                            │  │
│  │   • channels.message.send --channel whatsapp                  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Channels: whatsapp (paired, target: 050-000-0000)                  │
│  Plugins:  google (Gmail+Sheets+Drive), browser, tavily, anthropic  │
└─────────────────────────────────────────────────────────────────────┘
```

## 4. רכיבים

### 4.1 Auth & Secrets
| שירות | סוג | איך |
|---|---|---|
| Anthropic (Claude) | CLI auth דרך `claude-cli` runtime | **רץ על המנוי הקיים שלך, אפס עלות נוספת** |
| Gmail | OAuth 2.0 read-only | `openclaw configure` → google plugin → OAuth flow |
| Google Sheets | OAuth (same google plugin) | אותה הרשאה |
| Tavily | API key | `openclaw secrets set TAVILY_API_KEY ...` |
| LinkedIn | Browser session | login חד-פעמי דרך browser plugin |
| WhatsApp | QR pairing | `openclaw channels add --channel whatsapp` |

### 4.2 Skill `job-scout`
מיקום: `~/.openclaw/agents/main/skills/job-scout/`
קבצים:
- `SKILL.md` — metadata + triggers + system prompt
- `prompt.md` — full instructions + JSON output schema
- `sources.json` — מקורות חיפוש + queries
- `keywords.json` — Hebrew/English patterns לזיהוי email statuses

### 4.3 Profile workspace
- `workspace/profile/cv.pdf` — PDF המקורי
- `workspace/profile/profile.md` — סיכום structured (קיים)
- `workspace/profile/cv-summary.json` — summary מעובד ע"י LLM פעם אחת (skills, years, level) — נוצר ב-bootstrap

### 4.4 Cron job
- שם: `job-scout-daily`
- שעון: `0 9 * * *` Asia/Jerusalem
- פעולה: agent turn → skill `job-scout`

### 4.5 Google Sheet
- שם: "Job Search Tracker — David Tubul"
- בעלים: owner@example.com
- ID נשמר ב-`workspace/.config/sheet-id`
- אם לא קיים → נוצר אוטומטית ב-bootstrap

## 5. טיפול בכשלים

| תרחיש | תגובה |
|---|---|
| LinkedIn captcha | log + המשך עם Tavily; alert WhatsApp פעם בשבוע |
| Gmail OAuth expired | log + skip stage 4 (חיפוש ימשיך); הודעה ב-WhatsApp עם הוראות refresh |
| Sheets API rate limit | exponential backoff עד 3 נסיונות; log error |
| Tavily quota exceeded | רק LinkedIn; log warning |
| LLM API error | retry x2; אם נכשל — skip the job (לא נכלל) |
| 0 משרות + 0 עדכוני סטטוס | לא שולח הודעה |
| הודעת WhatsApp נכשלה | retry x3 דקות; log; ההודעה תישלח עם הריצה הבאה |
| CV file deleted | error fatal; alert |

## 6. תוכנית rollout

| צעד | פעולה | מי | חד-פעמי? |
|---|---|---|---|
| 1a | Pair WhatsApp Web (QR) | David | ✓ |
| 1b | Create WhatsApp group "Job Scout 🤖" + remove placeholder | David | ✓ |
| 1c | Tell agent the group name → it resolves chat ID | agent | ✓ |
| 2 | OAuth Gmail + Sheets (google plugin) | David | ✓ |
| 3 | Tavily API key (free signup) | David | ✓ |
| 4 | Login LinkedIn דרך browser plugin | David | ✓ |
| 5 | LLM bootstrap → cv-summary.json | agent | ✓ |
| 6 | Create Sheet "Job Search Tracker" | agent | ✓ |
| 7 | Install skill `job-scout` | agent | ✓ |
| 8 | Create cron `job-scout-daily` | agent | ✓ |
| 9 | Dry run (no sending) — verify pipeline end-to-end | agent + David | ✓ |
| 10 | Enable cron, monitor יום 1 | both | recurring |

## 7. מה לא בתוך הסקופ

- חיפוש משרות גלובלי (Remote-global) — מקסימום Israel + Remote-IL
- שליחת קורות חיים אוטומטית (היוזם נשאר אצלך)
- ניקוד עומק חברה / glassdoor reviews / משכורת (אולי v2)
- אינטגרציה עם פלטפורמות מעבר ל-6 שהוגדרו
- ניהול multi-user
- מענה אוטומטי על מיילים

## 8. הצלחה

הסוכן עובד אם:
- ✅ במשך 7 ימים מקבל הודעת WhatsApp ב-09:00 כשיש משרות חדשות **או** שינויי סטטוס
- ✅ Precision ≥ 80% (לא יותר מ-20% משרות לא רלוונטיות בתוצאות)
- ✅ Sheets נשאר sync עם המציאות — סטטוס מתעדכן אוטומטית מ-Gmail בתוך 24 שעות מההודעה
- ✅ אפס duplicates במשך 30 יום
- ✅ CV-match score משקף סבירות הוגנת (David יסקור 20 דוגמאות בשבוע הראשון)

## 9. סיכונים פתוחים

- **LinkedIn TOS** — אזור אפור. שימוש פרטי לקריאה בלבד; אם נחסם → Tavily מספק כיסוי חלקי.
- **Gmail false positives** — אישורי הגשה ממערכות מגייסות לא תמיד מציינים את שם החברה במפורש. fuzzy match על דומיין שולח יעזור, אבל לא 100%. ה-Sheet ניתן לעריכה ידנית.
- **CV matching דיוק** — תלוי באיכות ה-prompt. נדרשת ולידציה עם 10-20 דוגמאות בשבוע ראשון.
- **Hebrew text in Sheets** — RTL ועברית עובדים ב-Google Sheets, אבל יש לוודא encoding נכון.
- **Gmail attachments / labels** — לא נוגעים בהם (read-only). אם תרצה auto-label "Applied" — תוספת ל-v2.
