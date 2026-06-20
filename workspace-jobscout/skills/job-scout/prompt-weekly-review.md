# Weekly self-review (owner-only) — learn from real outcomes, propose criteria tuning

Triggered by the `weekly-review` cron (Sat night). This is Scotty's self-improvement loop:
look at what the scout surfaced vs. what David actually did with it, distil the lessons, and
**propose** (never silently apply) criteria changes. Approval-gated per SKILL.md hard rule #8.

**Owner-only.** This whole mode is for David. There is no guest weekly review — guests have no
Sheet, so there is no outcome data to learn from. If somehow invoked for a guest, do nothing.

## Step 0 — pull the outcome funnel

```bash
cd /home/davidtobol2580/open_claw/workspace
node tools/weekly-review.mjs > /tmp/weekly-review.json
```

Read `/tmp/weekly-review.json`. It is the **whole Sheet** classified into an outcome funnel:
- `by_status` — overall win / applied / rejected / noise / pending counts.
- `by_source`, `by_level`, `by_score_bucket` — each with `engagement_rate` (David acted on it)
  and `noise_rate` (David marked it ⛔ Not Interested = the scout surfaced junk).
- `wins[]` — interview/offer jobs (what to **amplify**).
- `applied[]` — jobs David chose to apply to (relevant surfacing).
- `noise[]` — suggestions David rejected (what to **stop surfacing**).

> The funnel is cumulative (whole Sheet), not just this week — that's intentional: weekly trends
> are too sparse to learn from, but the cumulative pattern is robust. Note in the lessons file
> when the picture is still thin (few rows).

Also load David's **current** criteria so any proposal is a concrete diff, not a vague idea:
- `workspace-jobscout/people/david/sources.json` (`linkedin.keywords`, `tavily.queries`)
- `workspace-jobscout/people/david/profile/cv-summary.json` (`excluded_role_titles`, `excluded_sectors`,
  `excluded_locations`, `exclusion_signals`)

## Step 1 — analyse (your reasoning — you are the LLM)

Find the **signal**, distinguishing scout-quality from David's behaviour:
1. **Noisy patterns** — sources / score-bands / companies / recurring title-words that dominate
   `noise[]` (high `noise_rate`). These are what the scout should surface LESS. Look for a
   *concrete* lever: a title keyword to add to `excluded_role_titles`, a sector, a source whose
   `noise_rate` is high enough to deprioritise.
2. **Winning patterns** — what's common to `wins[]` and `applied[]` (sources, levels, score-band,
   company type, title words). These are what to surface MORE — e.g. a keyword to ADD to
   `sources.json`.
3. **Gaps** — are wins concentrated in a source the scout *doesn't* lean on? (e.g. if David's
   self-found / gmail jobs convert far better than LinkedIn, that's a coverage gap worth naming.)

Be honest and conservative. Only propose a change you can tie to a specific number in the funnel.
A weak or ambiguous signal → propose nothing this week and say so. Never propose dropping a keyword
that has any win/applied behind it. **You are not applying anything in this step.**

## Step 2 — write the lessons file (this is the only thing you persist now; it's just memory)

```bash
mkdir -p workspace-jobscout/data/lessons
WEEK=$(TZ=Asia/Jerusalem date +%G-W%V)   # e.g. 2026-W23
```

Write `workspace-jobscout/data/lessons/lessons-$WEEK.md` (overwrite if it already exists this week):

```markdown
# Lessons — week <WEEK>  (generated <YYYY-MM-DD>)

## Funnel (cumulative, N=<total>)
<one-line-per-source: source — engaged X% / noise Y% (n=Z)>; same for score-bands if telling.

## What worked (amplify)
- <pattern from wins[]/applied[], with the numbers behind it>

## What was noise (reduce)
- <pattern from noise[], with noise_rate / counts>

## PROPOSED CHANGES (pending David's approval — NOT yet applied)
<!-- machine-readable so a later Q&A turn can apply it verbatim after David says כן -->
```json
[
  {"file":"people/david/sources.json","op":"add","path":"linkedin.keywords","value":"<kw>","why":"<tie to a win>"},
  {"file":"people/david/profile/cv-summary.json","op":"add","path":"excluded_role_titles","value":"<word>","why":"<tie to noise_rate>"}
]
```
(If nothing is worth changing this week, write `[]` and a one-line reason.)
```

This file is **memory only** — writing it changes no behaviour. Editing the criteria files is a
separate, approval-gated step (Step 4).

## Step 3 — send David the proposal (Hebrew, to the shared group)

Send ONE WhatsApp message to the configured group (proactive push — use `openclaw message send`,
since this is the cron path, not a live reply):

```bash
GROUP=$(node -e "console.log(require('./.config/job-scout.json').whatsapp.group_id)")
/home/davidtobol2580/open_claw/openclaw message send --channel whatsapp --target "$GROUP" --message "<msg>"
```

Message shape — **a FULL, clearly-explained Hebrew report** (David's standing preference, set 2026-06-13:
he wants to actually understand the numbers, not a terse/technical summary). Plain WhatsApp text
(no markdown tables — they don't render); use *bold*, emojis, and `━━━` separators between sections.
Always **explain the jargon in plain Hebrew the first time it appears** — David is not expected to
know the terms. Structure:
- 📊 כותרת + שורת פתיחה: "בוקר טוב דוד! סיכום שבועי מלא של מה למדתי על החיפוש שלך".
- *מה זה הדו"ח הזה?* — שורה-שתיים שמסבירות שזו בדיקה-עצמית שבועית, ושאתה רק מציע ולא משנה לבד.
- *🔻 המשפך* — הסבר ש"משפך" = הרבה משרות נכנסות, מעט הופכות להגשה; ואז המספרים: זכייה / הגשת / נדחית / רעש / ממתין. הגדר *רעש* במפורש = "משרה ששלחתי אבל לא התאימה — בזבוז תשומת לב".
- *📍 לפי מקור* — שורה לכל מקור משמעותי (LinkedIn/Gmail/Telegram) עם אחוז הרעש והערה אנושית (מי המנוע, מי "מרמה" כי הן משרות שדוד מצא לבד).
- *🎯 ציון ההתאמה* — הסבר ש"ציון" = 0–100 לכמה משרה מתאימה; הצג אילו טווחי-ציון התבררו כטובים/גרועים עם המספרים, וסמן את הטווח הבעייתי כ"ההזדמנות הכי גדולה לשיפור".
- *👍 מה עבד / 👎 מה היה רעש* — דפוסים מ-`wins[]`/`applied[]` מול `noise[]`, עם המספרים והשמות (חברות/מילות-כותרת).
- *✅ שורה תחתונה* — משפט סיכום.
- אם יש הצעת-תיקון: הצג אותה בבירור (מה בדיוק ישתנה ולמה, וכמה נתונים מאחוריה — סמן הצעה דלת-נתונים כ"בטחון נמוך"), ובקש אישור: **"רוצה שאחיל? תענה 'כן תחיל'"**.
- אם אין מה לשנות: אמור זאת במפורש בשורה התחתונה — "השבוע אין שינוי מומלץ, הקריטריונים נראים תקינים".

The report can be long — that's fine and desired. Clarity over brevity.

Then **STOP**. Do NOT edit any criteria file in the cron run. The proposal waits for David.

## Step 4 — applying the proposal (happens LATER, in a Q&A turn — described here for continuity)

When David later replies approval (`כן תחיל` / `אשר` / `go ahead`), that arrives as a normal Q&A
message. Per SKILL.md hard rule #8 (controlled self-modification): read the newest
`workspace-jobscout/data/lessons/lessons-*.md`, take its `PROPOSED CHANGES` JSON block, apply each edit to
the named file (add to the array if not already present), confirm in Hebrew exactly what changed,
and note that it takes effect on the next scout run. If David says no / ignores it, apply nothing —
the lessons file stays as a record either way. Never apply without an explicit approval.
