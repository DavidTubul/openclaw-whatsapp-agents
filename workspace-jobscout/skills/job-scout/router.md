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
| `(?i)(תעדכן|תסנכרן|עבור על|תעבור על).{0,12}(הערות|סטטוס(ים)?)` | reconcile-status-from-notes — read each row's manual notes (col M) and update status (col K). See prompt-qa.md "Reconcile statuses from manual notes". |
| `https?://\S+` | enrich-or-add job (URL detected) — match an existing row (esp. `gmail-self-apply` / empty-url rows) and fill its details; only append if no match. See prompt-qa.md "Handling a job link". |
| `(?i)(מה|what|ספר לי) .{1,80} (עושים|do|company)` | about-company |
| `(?i)(תוסיף|תוסף|הוסף|תתקן|תשנה|תתאים|תלמד) (לעצמך\|את עצמך\|לך)?` · "מהיום כש… תעשה…" · a request for a capability you don't currently have | **self-extend** (OWNER ONLY) — load `prompt-self-extend.md`. One-off vs. permanent; plan→approve→snapshot→edit→verify→revert-on-fail via `tools/self-edit.mjs`. |
| `(?i)מה שינית\|מה עדכנת\|היסטוריית שינויים\|what did you change` | self-extend changelog — `node tools/self-edit.mjs changelog 15`, answer ONLY from it. |

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

**⚠️ But never WRITE by row number.** The sheet auto-re-sorts on every status change/append, so a row
index is only valid at the instant you read it. To edit: read fresh → resolve the target to its stable
`id` (col A) → `sheet.mjs update-by-id <id> '{...}'` → verify the returned `row_after`. See prompt-qa.md
"⚠️ Editing the Sheet safely". The N→N+1 mapping is for *resolving which row David means*, then you take
that row's `id` — not for addressing the write.

## Owner-only people admin (multi-tenant)

These manage `workspace-jobscout/.config/people.json`. **Only the resolved `owner` (David) may run them**
(resolve the sender per prompt-qa.md "Step 0"); a **guest** or **unknown** sender is refused politely
in Hebrew. See prompt-qa.md "ניהול אנשים — בעלים בלבד" for the exact actions/confirmations.

| Input | Intent |
|---|---|
| `/people` | list people (id, name, role, enabled) |
| `/disable <id>` (NL: "תעצור ל-<שם>", "תוריד את <שם>") | set `enabled:false` — DEFAULT meaning of "delete/remove someone" (reversible) |
| `/enable <id>` (NL: "תחזיר את <שם>") | set `enabled:true` |
| "תמחק לגמרי את <שם>" | HARD delete — needs explicit "כן" confirmation; then `rm -rf workspace-jobscout/people/<id>/` + drop the registry entry |
| `/add` | needs profile + CV files → must be done in a dev session, not from chat |

## One-off / scheduled modes (added 2026-07-15)

| Input | Intent |
|---|---|
| message containing `backfill` / `סריקת בסיס` (owner only) | one-time full sweep → `prompt-backfill-david.md` (SKILL.md routing rule 4) |
| cron message containing `daily-question` | daily interview question → `prompt-daily-question.md` (SKILL.md routing rule 5) |
