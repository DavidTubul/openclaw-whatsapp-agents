# ACTIVATION.md — חיבור זורו ⚔️ לאוויר (צ'ק-ליסט wiring)

כל מה שבתיקייה בנוי ונבדק, אבל **לא חובר**. הצעדים האלה מחברים את זורו ל-WhatsApp. הם עורכים את
`~/.openclaw/openclaw.json` ה**משותף** (הגייטוויי שמריץ את סקוטי + דיגיט + דאוס + פיצי), אז בזהירות.

> ⚠️ עריכות `channels.whatsapp.*` דורשות `openclaw gateway restart` נקי **כשהצ'אט בשקט** — hot-reload חי
> מנער את הסוקט ויכול להפיל הודעות יוצאות לדקות. עריכות קבצי agent/skill/prompt עושות hot-reload בסדר.

## שלב 1 — צור קבוצה וקבל group_id (פשוט — ראה RUNBOOK "Finding a new group's group_id")

1. **הוסף את מספר הבוט לקבוצה.** הגייטוויי מחובר כחשבון אחד — **<BOT_PHONE>** (אמת: `openclaw directory self --channel whatsapp`). ⚠️ **בלי שהמספר הזה חבר בקבוצה, שום הודעה לא מגיעה לבוט ולא יופיע כלום בלוג** — זו כל ה"מורכבות".
2. שלח הודעה כלשהי בקבוצה.
3. קרא את ה-id ישירות מהלוג:
   ```bash
   journalctl --user -u openclaw-gateway.service --since "-5 min" | grep -E '120363[0-9]{10}@g\.us'
   # → [whatsapp] Inbound message <THE_ID>@g.us -> <BOT_PHONE> (group, N chars)
   ```
   (שורת ה-`Inbound message` נרשמת לפני סינון ה-allowlist, אז ה-id מופיע גם אם הקבוצה עוד לא מאושרת — כל עוד הבוט חבר בקבוצה.)
4. הצב את ה-id ב-`shared/registry.json` — בתוך מפת ה-`groups` העליונה (`{jid,label,requireMention:true}`) וברשימת ה-`groups` של הסוכן `zorro`. (⚠️ פרטי החיווט של WhatsApp כבר **לא** יושבים ב-`bot.json` — הם נמחקו משם; `bot.json` נשאר לקונפיג דומיין בלבד.)

> 🔒 לעולם אל תנחש group_id — אמת מ-inbound אמיתי (זיכרון-משתמש: "לעולם לא לנחש יעד הודעות").
> ❌ אל תפתח `groupPolicy: open` כדי "לגלות" id — זה מרכך גישה לכל הסוכנים, דורש restart, ולא יעזור אם הבעיה היא אי-חברות (אין הודעה שתגיע בכלל).

## שלב 1.5 — רשום את הסוכן ב-`shared/registry.json` (registry v2 — מקור אמת יחיד לכל החיווט)

ה-hooks המשותפים + מנועי ה-self-edit/session-hygiene **וגם כל החיווט של WhatsApp** מזהים כל בוט דרך
**הרישום המרכזי** `shared/registry.json` (registry v2). מבנה: מפת `groups` עליונה (שם סמלי → `{jid,label,requireMention,…}`);
`owner` פעם אחת בראש; לכל סוכן `identity {name,emoji}`, `groups`/`primaryGroup` סמליים, ו-`cronTargets`.
ודא שיש בו ערך ל-`zorro` עם הקבוצה הנכונה (כבר קיים — זורו חי). בוט חדש מוסיף כאן ערך אחד.

## שלב 2 — סנכרן את openclaw.json מהרישום (registry-sync — אל תערוך ידנית)

> ⚠️ **הפרוצדורה הידנית הישנה ("ערוך 4 מקומות ב-openclaw.json") הוחלפה.** `openclaw.json` נגזר מ-`shared/registry.json`.
> אחרי שלב 1.5 הרץ `node ~/open_claw/shared/tools/registry-sync.mjs --check` (לראות את הדריפט) ואז `--apply` — הוא כותב
> את רישום הסוכן ב-`agents.list[]` (כולל `mentionPatterns` עברי מפורש מתוך `identity`), את ה-allowlist לקבוצה, מקדים את
> ה-`route` ב-`bindings[]` לפני ה-catch-all של main, מכוון את `delivery.to` של כל cron, ומגבה את שני הקבצים ל-`shared/backups/registry-sync/`.
> הבלוקים למטה נשארים כ**תיעוד למה ש-registry-sync מייצר** — לא כהוראה לערוך ידנית.

**(א) רישום הסוכן** — הוסף ל-`agents.list[]`:
```json
{
  "id": "zorro",
  "name": "zorro",
  "identity": { "name": "זורו", "emoji": "⚔️" },
  "groupChat": { "mentionPatterns": ["זורו"] },
  "workspace": "~/open_claw/workspace-quitsmoke",
  "agentDir": "~/.openclaw/agents/zorro/agent",
  "model": "anthropic/claude-sonnet-5"
}
```
> ⚠️ **mentionPatterns חייב להיות מפורש `["זורו"]`** — ה-regex האוטומטי `\b@?name\b` הוא ASCII-only ולא תופס עברית. זה בדיוק מה שהשתיק את דיגיט בהתחלה.
> מודל: הקונפיג החי הוא `anthropic/claude-sonnet-5` (גם לשיחה וגם לבוקר). ניתן לשלוט במודל של ה-cron ב-`--model` (שלב 4).

**(ב) Allowlist לקבוצה** — תחת `channels.whatsapp.accounts.default.groups`, הוסף:
```json
"<GROUP_ID>@g.us": { "requireMention": true }
```
(`groupPolicy` הוא `"allowlist"` — קבוצה לא-מאופשרת מתעלמים ממנה לגמרי.)

**(ג) ניתוב הקבוצה לזורו** — הוסף כ**ערך הראשון** ב-`bindings[]` (peer match גובר על fallback של main; אל תיגע ב-bindings של האחרים):
```json
{ "type": "route", "agentId": "zorro",
  "match": { "channel": "whatsapp", "accountId": "default", "peer": { "kind": "group", "id": "<GROUP_ID>@g.us" } } }
```

**(ד) טעינת ה-hooks** — ה-hooks משותפים לכל הבוטים (`shared/hooks/`), נטענים מערך **יחיד**
ב-`hooks.internal.load.extraDirs` ומזהים את זורו לפי ה-group jid דרך `shared/registry.json`.
אם הערך כבר קיים (כי בוט אחר חובר), **אין מה להוסיף**. אחרת:
```json
"~/open_claw/shared/hooks"
```
(הדירקטוריה הישנה `workspace-quitsmoke/tools/hooks` נמחקה ברפקטור ה-shared מ-2026-06-26 — אל תפנה אליה.)

## שלב 3 — אתחל את הגייטוויי (צ'אט בשקט)
```bash
~/open_claw/openclaw gateway restart
# המתן ~90–130 שניות ל-"Listening for WhatsApp inbound messages", בלי 408 חוזרים
```
ואז שלח בקבוצה "זורו, מי אתה?" → צפוי 👍 ופתיח עוקצני בעברית.

## שלב 4 — צור את משימת בעיטת הבוקר (cron 08:00)

```bash
~/open_claw/openclaw cron add \
  --name "zorro-daily" \
  --cron "0 8 * * *" --tz "Asia/Jerusalem" \
  --agent zorro --session isolated --wake now \
  --model "anthropic/claude-sonnet-5" --thinking high \
  --announce --channel whatsapp --to "<GROUP_ID>@g.us" \
  --message "השתמש ב-skill quit-coach וקרא את skills/quit-coach/prompt-daily.md, ובצע את בעיטת הבוקר המלאה: בחר מ-content.md פריט שעוד לא נשלח (בדוק data/daily/sent.jsonl), נסח אותו באופי העוקצני שלך, סיים בתשאול 'עמדתם אתמול? נקי/נפלתי', צרף הצצה לטבלת הצדק (node tools/streaks.mjs leaderboard), ורשום את מה ששלחת ל-data/daily/sent.jsonl. עברית בלבד, קצר וחד."
```
בדיקה: `openclaw cron list` → הג'וב מופיע; `openclaw cron run <id>` → מריץ עכשיו לבדיקה (יישלח לקבוצה!).

## שלב 5 (מומלץ) — session-hygiene timer (כמו לדאוס)

כדי שזורו לא ייפול ב-compactor השבור, שכפל את יחידות ה-systemd של דאוס והפנה לזורו:
- מקור: `~/.config/systemd/user/openclaw-session-hygiene-poker.{service,timer}`
- צור `openclaw-session-hygiene-zorro.{service,timer}` זהים, עם `ExecStart` שמריץ
  `node ~/open_claw/workspace-quitsmoke/tools/session-hygiene.mjs` (אותו node 22 כמו ביחידת poker).
- `systemctl --user daemon-reload && systemctl --user enable --now openclaw-session-hygiene-zorro.timer`
- בדיקה: `node tools/session-hygiene.mjs --dry-run` → מדווח מה היה עושה.

> ⚠️ הכלי כותב ל-`agents/zorro/sessions/sessions.json` ולמפתח `agent:zorro:...` — תקין רק **אחרי** שהסוכן `zorro` רשום (שלב 2) והופעל לפחות פעם.

## שלב 6 (אופציונלי) — טבלת הצדק החיה ב-Google Sheets

1. עקוב אחרי בלוק ה-SETUP בראש `tools/apps-script-webhook.gs` (צור Sheet → הדבק סקריפט → הצב `SHEET_ID` → Deploy as Web app → העתק `/exec` URL).
2. הצב ב-`.config/bot.json` → `sheet.webhook_url`, ו-`sheet.enabled: true`.
3. בדיקה: `node tools/streaks.mjs add-member "בדיקה"` → התשובה תכלול `sheet.ok:true`, והשורה תופיע ב-Sheet (טאב "צדק").
עד אז הכול נשמר מקומית ב-`data/streaks/members.jsonl` (`node tools/streaks.mjs export-csv` → CSV לאדם).

## שלב 7 — סמוק-טסט

1. "זורו, מי אתה?" → פתיח עוקצני.
2. "תרשום אותי" → `add-member` → ברכת "ברוך הבא לעבודה הקשה".
3. "עמדתי" → `checkin clean` → כבוד + עקיצה (ואם נחצה milestone — חגיגה).
4. "נפלתי" → `checkin smoked` → ג'אב + הרמה, וה-streak מתאפס.
5. "מי מוביל?" → `leaderboard`.
6. המתן ל-08:00 (או `cron run`) → בעיטת הבוקר מגיעה לקבוצה.

## Rollback

הסר את 4 העריכות מ-`openclaw.json` (הסוכן, הקבוצה, ה-binding, תיקיית ה-hooks), בטל את ה-cron
(`openclaw cron rm <id>`) ואת ה-timer, ואתחל גייטוויי. `workspace-quitsmoke/` עצמאי — מחיקתו מסירה את
זורו לחלוטין בלי השפעה על שאר הסוכנים.
