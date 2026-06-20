// policy.mjs — deterministic compensation logic for freshness complaints.
// The LLM reads the expiry date off the photo (vision) and judges authenticity;
// this module does the DATE MATH and applies the written policy, so the
// money-affecting decision is reproducible and unit-tested (never improvised).

const DAY_MS = 86400000;

/**
 * Parse an expiry string into an ISO date (YYYY-MM-DD), best-effort.
 * Handles the common formats printed on Israeli product bags:
 *   "31/12/2026", "31.12.2026", "31-12-2026"  → that day
 *   "12/2026", "12.26", "12/26"                → END of that month (shelf-life convention)
 *   "2026-12-31" (already ISO)                 → as-is
 * Returns null if it can't parse confidently (→ caller routes to human review).
 */
export function parseExpiryDate(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  // already ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // full day: d/m/y or d.m.y or d-m-y  (day first — Israeli convention)
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    const day = +d, mon = +mo;
    const year = normYear(y);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31 && year) {
      return iso(year, mon, day);
    }
    return null;
  }

  // month/year only: m/y or m.y  → end of that month
  m = s.match(/^(\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const mon = +m[1];
    const year = normYear(m[2]);
    if (mon >= 1 && mon <= 12 && year) return iso(year, mon, lastDayOfMonth(year, mon));
    return null;
  }

  return null;
}

function normYear(y) {
  const n = +y;
  if (String(y).length <= 2) return 2000 + n; // "26" → 2026
  return n >= 1900 && n <= 9999 ? n : null;
}
function lastDayOfMonth(year, mon) {
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}
function iso(year, mon, day) {
  const mm = String(mon).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Whole days from `today` (ISO) until `expiry` (ISO). Negative = already expired. */
export function daysUntil(expiryISO, todayISO) {
  if (!expiryISO || !todayISO) return null;
  const e = Date.parse(expiryISO + "T00:00:00Z");
  const t = Date.parse(todayISO + "T00:00:00Z");
  if (Number.isNaN(e) || Number.isNaN(t)) return null;
  return Math.round((e - t) / DAY_MS);
}

/**
 * Decide a freshness-complaint outcome from the written policy.
 *
 * @param {object} a
 * @param {string} a.expiry         raw expiry string read off the bag (or ISO)
 * @param {string} a.today          ISO date "YYYY-MM-DD" (pass it in — no clock here)
 * @param {boolean} a.hasFront      a front-of-bag photo was provided & verified
 * @param {boolean} a.hasBack       a back-of-bag photo (with expiry) was provided & verified
 * @param {boolean} a.authentic     the LLM's verdict that the photos are genuine (real bag, brand, not screenshot/reused)
 * @param {number} a.priorClaims    count of prior claims from this phone within period_days
 * @param {object} policy           bot.json compensation_policy
 * @returns {{eligible:boolean, status:string, packages:number, reason:string, days_to_expiry:(number|null)}}
 */
export function decideCompensation(a, policy) {
  const P = {
    min_days_to_expiry: 60,
    replacement_packages: 2,
    require_front_and_back: true,
    max_claims_per_phone_per_period: 1,
    ...(policy || {}),
  };
  const expiryISO = parseExpiryDate(a.expiry);
  const days = daysUntil(expiryISO, a.today);

  const REVIEW = (reason) => ({ eligible: false, status: "ממתין לבדיקת אדם", packages: 0, reason, days_to_expiry: days });
  const DENY = (reason) => ({ eligible: false, status: "נדחה", packages: 0, reason, days_to_expiry: days });

  // 1. authenticity gate (anti-fraud) — FAIL-CLOSED. Only an explicit `authentic === true`
  //    verdict may proceed. An omitted/undefined verdict (the LLM simply not emitting the field)
  //    must NOT pay out: treat "unknown" as "not verified" and route to human review. (Hard rule
  //    #4: authenticity is mandatory before any approval.)
  if (a.authentic !== true) return REVIEW("התמונה לא אומתה כאותנטית — חשד/לא ברור");
  if (P.require_front_and_back && (!a.hasFront || !a.hasBack)) {
    return REVIEW("חסרה תמונת חזית או גב של השקית");
  }

  // 2. abuse gate
  if (typeof a.priorClaims === "number" && a.priorClaims >= P.max_claims_per_phone_per_period) {
    return REVIEW(`חריגה ממכסת התביעות (${a.priorClaims} קודמות בתקופה) — בדיקת אדם`);
  }

  // 3. expiry readability
  if (expiryISO == null) return REVIEW("לא ניתן לקרוא/לפענח את תאריך התוקף מהתמונה");

  // 4. the policy rule: far-enough expiry ⇒ legitimate freshness complaint ⇒ replacement
  if (days != null && days >= P.min_days_to_expiry) {
    return {
      eligible: true,
      status: "מאושר - לשליחה",
      packages: P.replacement_packages,
      reason: `תוקף עוד ${days} ימים (≥ ${P.min_days_to_expiry}) — בתוך חיי המדף, תלונה לגיטימית`,
      days_to_expiry: days,
    };
  }

  // 5. expiry near/passed ⇒ not automatic (customer storage) ⇒ human
  if (days != null && days < 0) return REVIEW(`המוצר פג תוקף (לפני ${Math.abs(days)} ימים) — בדיקת אדם`);
  return REVIEW(`תוקף קרוב (עוד ${days} ימים, פחות מ-${P.min_days_to_expiry}) — לא זכאות אוטומטית, בדיקת אדם`);
}
