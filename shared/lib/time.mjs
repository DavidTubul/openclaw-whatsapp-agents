// shared/lib/time.mjs — timezone-correct date helpers, ONE implementation for every bot.
//
// Why this exists: four divergent `today()` copies grew across the workspaces, and the zorro copy
// used `toISOString()` (UTC) — a member checking in between 00:00–03:00 Israel time was stamped on
// the PREVIOUS day (off-by-one streaks, double reminders). All bots serve Israeli groups; date
// arithmetic must be done in the group's timezone, never the host's or UTC.

export const DEFAULT_TZ = 'Asia/Jerusalem';

/** YYYY-MM-DD in the given IANA timezone (en-CA locale renders exactly that shape). */
export function todayInTz(tz = DEFAULT_TZ, d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** HH:MM (24h) in the given IANA timezone. */
export function timeInTz(tz = DEFAULT_TZ, d = new Date()) {
  return d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/**
 * Wall-clock date + hour + minute in the given timezone: { date:'YYYY-MM-DD', hh, mm }.
 * Ported verbatim (behavior) from session-hygiene.mjs's `jerusalemParts` — the ONE place that
 * decomposed an instant into tz-local Y/M/D + hour + minute for the daily-reset window gate.
 * NOTE arg order is (date, tz) — date first — matching the section-A helpers stampInTz/displayInTz,
 * NOT the (tz, date) order of todayInTz/timeInTz above.
 */
export function partsInTz(date = new Date(), tz = DEFAULT_TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}

/**
 * Human display string in the given timezone/locale. Ports boot-notify.mjs's `fmt()` semantics:
 * he-IL locale, short date + short time by default, falling back to ISO on any Intl error.
 * Extra Intl.DateTimeFormat options can be passed through and override the short/short defaults.
 */
export function displayInTz(date = new Date(), { locale = 'he-IL', tz = DEFAULT_TZ, ...opts } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return d.toLocaleString(locale, { timeZone: tz, dateStyle: 'short', timeStyle: 'short', ...opts });
  } catch {
    return d.toISOString();
  }
}

/**
 * 'YYYYMMDD-HHMMSS' local-wall-clock stamp in the given timezone (e.g. for backup/snapshot ids).
 * hourCycle 'h23' guarantees a 00–23 hour, matching the host getHours() this replaced in self-edit.
 * (partsInTz above deliberately keeps the verbatim hour12:false form; this one needs seconds + h23.)
 */
export function stampInTz(date = new Date(), tz = DEFAULT_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
