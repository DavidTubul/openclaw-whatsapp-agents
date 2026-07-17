# workspace-quitsmoke — זורו ⚔️ (dev map)

> מפת פיתוח לבני-אדם / סשני dev. **לא** נטען אוטומטית לפרומפט של הבוט (ראה repo `CLAUDE.md` —
> OpenClaw מזריק רק `AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md, HEARTBEAT.md`).
> סטטוס: **live** — חובר לקבוצה "חאלס לעשן" (`<GROUP_ID>@g.us`, requireMention) 2026-06-26;
> שיחה עובדת. נשאר אופציונלי: cron בעיטת הבוקר + פריסת Google Sheet. נסקר לאחרונה: 2026-06-26.

## מי זה זורו

**זורו ⚔️** — קואצ'ר גמילה מעישון לקבוצת WhatsApp בעברית. אופי: **"שוטר רע" עוקצני ושנון** שמצית
מוטיבציה — עוקץ תירוצים, חוגג ניצחונות עם ג'אב, לא מוותר על מי שנפל. עברית, קבוצה אחת, מגיב כשפונים
אליו "זורו" (`requireMention: true`). אישר David את השם והאופי 2026-06-26.

ארבעה תפקידים:
1. **בעיטת בוקר** (cron 08:00) — עובדה/סיפור על נזקי עישון (+תמונה אופציונלית) + תשאול "עמדת אתמול?" + הצצה לטבלה.
2. **טבלת הצדק** — מעקב רצף נקי לכל חבר, lifetime, leaderboard. דרך `tools/streaks.mjs`.
3. **תשאול יומי** — קליטת "עמדתי/נפלתי" → עדכון streak → תגובה באופי.
4. **מענה לשאלות** — נזק/חשק/תסמינים/טיפים, מבוסס `knowledge.md`.

## מבנה

```
workspace-quitsmoke/
├── AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md   # מוזרקים לפרומפט
├── CLAUDE.md            # ← אתה כאן (dev map)
├── ACTIVATION.md        # צ'ק-ליסט חיבור לאוויר (עריכות openclaw.json + cron)
├── RECENT_CHAT.md       # מראת רציפות (נכתב ע"י hook)
├── .config/{bot.json, bot.example.json}
├── skills/quit-coach/
│   ├── SKILL.md         # נקודת כניסה + ניתוב + כללים קשיחים
│   ├── router.md        # טבלת כוונות עברית → פעולה
│   ├── prompt-daily.md  # זרימת בעיטת הבוקר (cron)
│   ├── prompt-qa.md     # זרימת תור שיחה
│   ├── prompt-self-extend.md  # שיפור עצמי owner-only (snapshot→verify→revert→log)
│   ├── knowledge.md     # ידע גמילה מבוסס (WHO/CDC) — מקור אמת לעובדות
│   └── content.md       # מאגר תוכן הבוקר המתחלף (+ sent log למניעת חזרות)
├── tools/
│   ├── streaks.mjs + lib/streaks.mjs (+ tests)   # טבלת הצדק (לוגיקה טהורה + CLI)
│   ├── morning-kick.mjs + lib/morning.mjs (+ test) # בעיטת הבוקר הדטרמיניסטית (בחירת פריט + sent.jsonl + leaderboard JSON)
│   ├── self-edit.mjs (+ test)                     # shim דק → shared/bin/self-edit.mjs (agentId zorro)
│   ├── session-hygiene.mjs (+ test)              # shim דק → shared/lib/session-hygiene.mjs (agentId zorro)
│   └── apps-script-webhook.gs                    # Google Apps Script לטבלה חיה
│                                                  # ה-hooks משותפים (shared/hooks/) — לא per-workspace; נמחקו 2026-06-26
└── data/
    ├── streaks/members.jsonl   # מקור אמת ל-streaks
    ├── daily/sent.jsonl        # מה כבר נשלח בבוקר (אנטי-חזרה)
    ├── chat-log/               # תמלילי שיחה (נכתב ע"י hook)
    ├── memory/lessons.md       # זיכרון לומד (פרטי)
    └── images/                 # תמונות מאושרות לבוקר (+README)
```

## כלי הליבה — `tools/streaks.mjs`

מקור אמת: `data/streaks/members.jsonl`. **`quit_date` הוא האמת; `clean_days` נגזר** (today − quit_date)
→ לא יכול לסטות גם אם פספסו דיווח. `checkin clean` רק חותם last_check; `checkin smoked` מבריח
longest_streak, מאפס (quit_date=מחר), וסופר relapse. פקודות: `add-member · checkin · relapse · read ·
list · leaderboard · pending · stats · set · sync-sheet · remind-pending · export-csv`
(`sync-sheet` = דחיפת clean_days הנגזר של כולם ל-Sheet, `remind-pending` = תיוג+נדנוד למי שלא דיווח היום —
שתיהן רצות יומית מטיימרי systemd: `openclaw-zorro-sheet-sync.timer`, `openclaw-zorro-remind-pending.timer`).
כל הפלט JSON. מירור אופציונלי ל-Google Sheet
כש-`sheet.enabled=true` (אותו דפוס webhook כמו סקוטי/פיצי — בלי service-account/googleapis).

בדיקות (לוגיקה ייחודית לזורו): `node --test tools/lib/streaks.test.mjs tools/streaks.test.mjs
tools/self-edit.test.mjs` (`self-edit.test.mjs` מריץ את ה-shim כ-CLI). בדיקות session-hygiene + ה-hooks +
מנועי shared/lib המשותפים רצות מ-`shared/` (`cd shared && node --test`, כולל `session-hygiene.test.mjs` +
`chat-log.test.mjs`).
`env DROR_DATA_DIR` ❌ — שם משתנה הבידוד הוא **`ZORRO_DATA_DIR`** (CLI test) / **`SELF_EDIT_DIR`** (self-edit).

## לקחים מהבוטים הקודמים שהוטמעו כאן

- **mention pattern עברי חייב להיות מפורש** ב-openclaw.json (`["זורו"]`) — ה-regex האוטומטי ASCII-only לא תופס עברית (זה מה שהשתיק את דיגיט בהתחלה). ראה ACTIVATION.
- **session hygiene** מותקן מראש (timer ייעודי) כדי לא ליפול ב-compactor השבור שהשתיק את סקוטי/דאוס.
- **נתיבי systemd** — אחרי rename של workspace, יחידות שמצביעות לנתיב ישן נופלות 203/EXEC. כאן הנתיב יציב (`workspace-quitsmoke`); אם משנים — לעדכן יחידות.
- **תמיד עונה / לעולם לא NO_REPLY** בקבוצה ייעודית; **אסור לכפול `message send`** בשיחה (משכפל).
- **בריאות = רגיש:** עוקצנות מכוונת לתירוצים; מצוקה/רפואה → להוריד הילוך ולהפנות לאיש מקצוע. מוטמע ב-SOUL/AGENTS/knowledge.

## סטטוס ושלבים הבאים

**live** — חובר לקבוצה "חאלס לעשן" ב-2026-06-26 (ראה כותרת); שיחה עובדת, וטיימרי systemd יומיים
מריצים `streaks.mjs sync-sheet` ו-`streaks.mjs remind-pending`. לחיבור מחדש/שחזור — ראה `ACTIVATION.md`.
אופציונלי בהמשך: הוספת תמונות ל-`data/images/`.
