// streaks.mjs — pure logic for זורו ⚔️, the quit-smoking coach.
//
// The "טבלת צדק" (justice/streak table) is the heart of זורו: for each member we track
// the date they quit (quit_date) as the SOURCE OF TRUTH, and derive clean_days = (today -
// quit_date). The daily morning check-in confirms they're still clean (or records a relapse).
// Storing the quit DATE rather than a counter makes clean_days robust to missed check-ins —
// it can never drift, and a human can always verify it against a calendar.
//
// All functions here are PURE (no I/O, no clock) — the caller passes `today`/`date` in.
// This is what makes the money/streak math reproducible and unit-tested. The CLI wrapper
// (../streaks.mjs) does the file + Google-Sheet I/O around these.

const DAY_MS = 86400000;

// ---- dates ------------------------------------------------------------------------

/** Parse YYYY-MM-DD (or full ISO) → UTC midnight ms. Returns NaN if unparseable. */
export function dayMs(iso) {
  if (!iso) return NaN;
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

/** YYYY-MM-DD difference in whole days (to - from). */
export function daysBetween(fromISO, toISO) {
  const a = dayMs(fromISO), b = dayMs(toISO);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/** YYYY-MM-DD of (iso + n days). */
export function addDays(iso, n) {
  const a = dayMs(iso);
  if (Number.isNaN(a)) return null;
  return new Date(a + n * DAY_MS).toISOString().slice(0, 10);
}

// ---- names ------------------------------------------------------------------------

export function normName(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

/** Stable, file-safe id from a display name (keeps Hebrew letters). */
export function slugify(name) {
  const base = normName(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return base || "member";
}

/** Last-9-digits key so a local (05…) and international (97250…) form of the same number match. */
export function phoneKey(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : d;
}

/** Resolve a member by name (case-insensitive), id, or phone (local or international form). */
export function resolveMember(members, query) {
  if (!query) return null;
  const q = normName(query).toLowerCase();
  const qKey = phoneKey(query);
  return (
    members.find((m) => m.id === query) ||
    members.find((m) => normName(m.member_name).toLowerCase() === q) ||
    (qKey && members.find((m) => m.e164 && phoneKey(m.e164) === qKey)) ||
    members.find((m) => normName(m.member_name).toLowerCase().includes(q)) ||
    null
  );
}

// ---- streak math ------------------------------------------------------------------

/** Current clean-day count as of `today` (derived from quit_date; never negative). */
export function computeCleanDays(member, today) {
  if (!member?.quit_date) return 0;
  const d = daysBetween(member.quit_date, today);
  return d == null ? 0 : Math.max(0, d);
}

/** Money saved so far, derived from clean_days * (weekly_spend / 7). Null if no weekly_spend set. */
export function computeMoneySaved(member, today) {
  const weekly = Number(member?.weekly_spend);
  if (!weekly || Number.isNaN(weekly)) return null;
  return Math.round((weekly / 7) * computeCleanDays(member, today));
}

/**
 * Benefit milestones tied to the CDC quitting-timeline + common recovery markers.
 * `days` is whole clean days; `body` is the encouragement to send when first crossed.
 */
// NOTE: bodies are written IN זורו'S VOICE (a jab, not encouragement) because the
// coach echoes them on check-ins. Keep the health FACT (grounded), drop the 💪/"גאה"
// softness — comfort here is exactly the tone drift we're fighting. See AGENTS.md tone.
export const MILESTONES = [
  { days: 1,   label: "יום ראשון",   body: "24 שעות. הניקוטין בדם ירד לאפס והפחמן החד-חמצני התפנה. עשית את המינימום שכל חלש מסוגל לו — אל תחפש מדליה." },
  { days: 2,   label: "יומיים",      body: "יומיים. הטעם והריח חוזרים — עוד מעט תרגיש כמה מסריח מה שעשית לעצמך. אל תתרגש." },
  { days: 3,   label: "3 ימים",      body: "3 ימים. שיא הגמילה הפיזית מאחוריך, עבד. אין יותר 'קשה לי' — מכאן זה רק חולשה אם תיפול." },
  { days: 7,   label: "שבוע",        body: "שבוע. הריאות מתחילות לנקות את הזבל שדחפת להן. נבנה הרגל חדש — אל תהרוס אותו כמו לוזר." },
  { days: 14,  label: "שבועיים",     body: "שבועיים. קל לך יותר לנשום ולזוז. כן, ככה זה כשמפסיקים להרעיל את עצמך. הפתעה." },
  { days: 30,  label: "חודש",        body: "חודש. השיעול וקוצר הנשימה פוחתים. הגוף שלך כבר פחות עלוב — תמשיך לפני שתתפתה לחזור." },
  { days: 90,  label: "3 חודשים",    body: "3 חודשים. מחזור הדם והריאות השתפרו ברצינות. כבר לא עבד מוחלט — אבל אל תתרברב." },
  { days: 180, label: "חצי שנה",     body: "חצי שנה. הסיכוי שתחזור לעשן צנח. זה כבר אתה — אז אל תעשה עכשיו משהו מטומטם." },
  { days: 365, label: "שנה",         body: "שנה. הסיכון ללב צנח בחצי. עשית משהו אמיתי, עבד — פעם ראשונה. עכשיו אל תאבד אותו." },
];

/** Milestones whose threshold lies in (prevDays, nowDays] — i.e. newly crossed. */
export function crossedMilestones(prevDays, nowDays) {
  return MILESTONES.filter((m) => m.days > prevDays && m.days <= nowDays);
}

/**
 * Apply a daily check-in. result ∈ {"clean","smoked"}.
 *  - "clean":  member is still smoke-free as of `date`. We only stamp last_check/last_result;
 *              clean_days is always derived from quit_date so it stays correct even if a day
 *              was missed. Returns any milestones newly crossed since the last check.
 *  - "smoked": a relapse on `date`. The current streak ends; longest_streak is banked; the
 *              new streak restarts the NEXT day (quit_date = date+1) and total_resets++.
 * Returns { member: <updated>, wasRelapse, crossed:[...], cleanDays }.
 */
export function applyCheckin(member, result, date) {
  const before = computeCleanDays(member, date);
  const m = { ...member };
  const nowIsoDay = date;

  if (result === "smoked") {
    m.longest_streak = Math.max(m.longest_streak || 0, before);
    m.total_resets = (m.total_resets || 0) + 1;
    m.quit_date = addDays(date, 1); // fresh start tomorrow
    m.last_check = nowIsoDay;
    m.last_result = "smoked";
    return { member: m, wasRelapse: true, crossed: [], cleanDays: 0 };
  }

  // "clean"
  const cleanDays = before;
  m.longest_streak = Math.max(m.longest_streak || 0, cleanDays);
  m.last_check = nowIsoDay;
  m.last_result = "clean";
  // milestones crossed between the previous check and now
  const prevDays = member.last_check ? Math.max(0, daysBetween(member.quit_date, member.last_check) ?? 0) : -1;
  const crossed = crossedMilestones(prevDays, cleanDays);
  return { member: m, wasRelapse: false, crossed, cleanDays };
}

/** Build a fresh member record. */
export function newMember({ name, e164, quitDate, nowIso }) {
  const display = normName(name);
  return {
    id: slugify(display),
    member_name: display,
    e164: e164 ? String(e164).replace(/\D/g, "") : null,
    quit_date: quitDate,
    longest_streak: 0,
    total_resets: 0,
    last_check: null,
    last_result: null,
    joined: nowIso,
    updated: nowIso,
  };
}

// ---- views ------------------------------------------------------------------------

/** The justice table: members ranked by current clean days (desc), then longest, then name. */
export function leaderboard(members, today) {
  return members
    .map((m) => ({
      ...m,
      clean_days: computeCleanDays(m, today),
      money_saved: computeMoneySaved(m, today),
    }))
    .sort(
      (a, b) =>
        b.clean_days - a.clean_days ||
        (b.longest_streak || 0) - (a.longest_streak || 0) ||
        (a.total_resets || 0) - (b.total_resets || 0) ||
        normName(a.member_name).localeCompare(normName(b.member_name), "he")
    )
    .map((m, i) => ({ rank: i + 1, ...m }));
}

/** Members who have NOT checked in on `date` yet (for the morning check-in). */
export function pendingMembers(members, date) {
  return members.filter((m) => m.last_check !== date);
}

/** Aggregate stats across all members. */
export function aggregateStats(members, today) {
  const lb = leaderboard(members, today);
  return {
    members: members.length,
    total_clean_days: lb.reduce((s, m) => s + m.clean_days, 0),
    longest_active_streak: lb.length ? lb[0].clean_days : 0,
    longest_ever: members.reduce((s, m) => Math.max(s, m.longest_streak || 0), 0),
    total_resets: members.reduce((s, m) => s + (m.total_resets || 0), 0),
  };
}
