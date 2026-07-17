# TOOLS.md — הערות מקומיות

הסקילז מגדירים _איך_ הכלים עובדים. הקובץ הזה הוא ל_פרטים שלך_ — מה שייחודי להתקנה הזו.

## הכלים שלי (פירוט מלא ב-`skills/quit-coach/SKILL.md`)

- `node tools/streaks.mjs <cmd>` — **טבלת הצדק** (מעקב רצף נקי). הפקודות: `add-member | checkin | relapse | read | list | leaderboard | pending | stats | set | sync-sheet | remind-pending | export-csv`. מקור אמת מקומי: `data/streaks/members.jsonl`. אם `sheet.enabled=true` ב-`.config/bot.json` → דוחף גם ל-Google Sheet. כל הפלט JSON. `clean_days` נגזר מ-`quit_date` (לא נספר ידנית → לא סוטה). `sync-sheet` (דחיפה יומית של clean_days לכולם ל-Sheet) ו-`remind-pending` (תיוג+נדנוד למי שלא דיווח, פעם ביום) רצות אוטומטית מטיימרי systemd — לא צריך להריץ אותן בשיחה.
- `node tools/morning-kick.mjs [--dry-run]` — **בעיטת הבוקר הדטרמיניסטית** (משמש את ה-cron). בוחר פריט תוכן שלא נשלח, **רושם בעצמו ל-`data/daily/sent.jsonl`**, ומחזיר JSON: `{id, fact, leaderboard, pending, members}`. אידמפוטנטי ליום. אני רק מנסח את ה-`fact` בקול שלי ופולט — בלי לרשום בנרטיב, בלי `message send`.
- `node tools/self-edit.mjs <snapshot|verify|revert|log|changelog>` — harness בטיחות לשינוי-עצמי (owner-only). ראה `skills/quit-coach/prompt-self-extend.md`.
- `node tools/session-hygiene.mjs` — שומר על סשן שיחה קטן כדי לא להיתקל ב-compactor השבור. רץ אוטומטית דרך systemd timer (ראה ACTIVATION.md).
- שליחת תמונה/הודעה יזומה: `openclaw message send --channel whatsapp --target "$(node ~/open_claw/shared/tools/group-id.mjs zorro)" [--media <path/url>] --message "..."` (ה-JID הוא מקור-אמת ב-`shared/registry.json`). **רק** ל-cron/מדיה — לא בשיחה רגילה (ישכפל).

## הערות למילוי עם הזמן

```markdown
### שעות
- שעת בעיטת הבוקר: 08:00 (cron `zorro-daily`) — לעדכן אם דוד מבקש אחרת.

### טון
- כללי כיול ספציפיים שדוד ביקש: ____
```

זה דף העזר שלך — תוסיף כל מה שעוזר.
