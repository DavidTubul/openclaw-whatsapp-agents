# One-time FULL BACKFILL — David only (2026-07-15, requested by David)

You run a ONE-TIME comprehensive sweep for person `david`. Unlike the daily scout: NO seniority
filter, NO score threshold, NO sent-ledger drop. Role-field + location filters stay. Everything
goes to the Sheet; WhatsApp gets a summary + top-20. At the end, state IS persisted so tomorrow's
daily run reports only genuinely-new jobs.

Execute every step using your **exec/bash tool** and your own reasoning. Today's date: `date +%F`.
All paths are absolute. The OpenClaw CLI wrapper (handles Node version) is `~/open_claw/openclaw`.

## 0. RE-RUN GUARD (do this FIRST — the word "backfill" is a permanent substring trigger)
This is a ONE-TIME sweep. Before doing anything, check whether it already ran:
```bash
ls ~/open_claw/workspace-jobscout/data/runs/*-david-backfill.json 2>/dev/null
```
- **If any file matches AND the trigger message does NOT contain an explicit re-run confirmation**
  (`הרץ שוב` or `run again`): do NOT run the sweep. Send ONE short Hebrew WhatsApp message to the
  shared group saying the one-time backfill already ran on `<date from the matched filename>` and asking
  for an explicit confirmation to run it again, e.g.:
  `הבקפיל החד-פעמי כבר רץ ב-<DD/MM>. להריץ שוב? שלח "backfill הרץ שוב".` (the reply must contain
  `backfill`, otherwise SKILL.md routing rule 4 never brings it back to this prompt)
  Then STOP and end with exactly `NO_REPLY` — run NO further step.
- **If NO file matches**, OR the trigger message explicitly contains `הרץ שוב` / `run again`: proceed to
  Step 1 below (an explicit confirmation bypasses the guard even when a prior run exists).

Read `~/open_claw/workspace-jobscout/people/david/profile/cv-summary.json` first (scoring context).
Paths/tools work exactly as in `prompt-scout-person.md` — the tools read david's
`sources.json` / `allowed-locations.json` / `company-watchlist.json` themselves via `--person david`.

## 1. Gather EVERYTHING (persist ON — this run becomes the new baseline)
```bash
cd ~/open_claw/workspace-jobscout/tools
node search.mjs --person david
node linkedin.mjs --person david --window-days 30        # deep sweep, persists seen
node telegram.mjs fetch --person david
node ats.mjs --person david --window-days 90             # wide freshness window, persists seen + seen_updated
```
Note: linkedin/ats will mostly return already-seen ids as skipped — that is fine; the point of
`--window-days` here is maximum reach for NEW ids. For full coverage of PREVIOUSLY-DROPPED jobs,
ALSO run: `node linkedin.mjs --person david --window-days 30 --no-persist` and
`node ats.mjs --person david --no-persist` and merge those candidates in (they include seen jobs).

## 2. Score all candidates (Step 2 of prompt-scout-person.md) — but KEEP EVERYTHING except:
- internships/student/trainee
- clearly off-field roles (not QA/test/automation)
- excluded_sectors / exclusion_signals from cv-summary.json
- postings verifiably closed

Assign level + score + Hebrew reason to every kept candidate. Do NOT drop on score or level.

## 3. Dedup: ONLY against Sheet rows whose status is ✅ Applied / 📞 Interview / 🎉 Offer with
`found_at` within the last 30 days (those are live applications — skip). Everything else —
including ledger-known and previously-rejected/expired rows — is IN (mark ledger-known ones `repost: true`).
Note: unlike the daily scout, the sent-ledger is NOT used to drop candidates here — ledger-dedup is OFF for this run.

## 4. Sheet: append ALL kept candidates (one `sheet.mjs append` call, id via `jobkey.mjs`, status
`⏳ Pending`, note `בקפיצת בסיס 15/07` on each). For candidates matching an EXISTING row, update
that row instead of appending (avoid duplicate rows). Then `node sheet.mjs sort`.

## 5. WhatsApp (ONE message to the shared group, Hebrew):
```
@<David's e164> 🔵 סריקת עומק חד-פעמית הושלמה! — {DD/MM}
סרקתי את כל המקורות מחדש בלי פילטרים: {N} משרות פתוחות רלוונטיות נמצאו ({X} חדשות, {Y} הופעות-מחדש).
🏆 טופ 20 לפי התאמה:
1. {title} (score: {score}) — {company} · {location} · 🎚️ {level}
   🔗 {url}
...
📋 הכל בגיליון (ממוין לפי ציון): {sheet_url}
מחר בבוקר חוזרים למשטר הרגיל — רק משרות חדשות. 🤖
```
Send it with the proactive-push tool (owner e164 + the shared group JID, resolved from the
registry via `node ~/open_claw/shared/tools/group-id.mjs main`):
```bash
~/open_claw/openclaw message send --channel whatsapp --target "$(node ~/open_claw/shared/tools/group-id.mjs main)" --message "<the message>"
```

## 6. Ledger: `node ledger.mjs david add '[...]'` for EVERY job in the Sheet output of this run
(so the daily scout never re-sends them as new).

## 7. Log `data/runs/<date>-david-backfill.json`:
```json
{"date":"<YYYY-MM-DD>","person":"david","mode":"backfill","candidates":N,"kept":N,"sent":true}
```

## ⚠️ Final output discipline — DO NOT narrate (same rule as prompt-scout-person.md)

Your final assistant text can leak to the WhatsApp group as an unwanted meta-message. The ONLY
user-facing message is the single Step-5 `openclaw message send` you already made. No closing summary,
recap, or status line. Your final turn output must be **exactly** `NO_REPLY` — nothing before or after.
