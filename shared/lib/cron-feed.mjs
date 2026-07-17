// shared/lib/cron-feed.mjs
//
// SINGLE source of truth for the "deterministic content-feed" cron pattern used
// by every OpenClaw bot whose daily cron sends FIXED, pre-authored content
// (e.g. poker's daily lesson + evening quiz). It walks an ordered list of
// ready-to-send messages, one per run, wrapping at the end so the cron never has
// an empty message to announce.
//
// WHY THIS EXISTS: with delivery.mode=announce the cron agent's FINAL turn text is
// posted to the group verbatim. When a cron asks the agent to *compose + log +
// deliver*, the model's final message becomes a status report ("Lesson 6 delivered
// and logged…" / "נשלח ✅") and THAT ships — the real content never arrives
// (docs/RUNBOOK.md §199–206). A feed removes the LLM from the content path: the
// next item is emitted verbatim, so nothing else can leak.
//
// Pure logic, no I/O — the CLI (shared/tools/cron-feed.mjs) does the file reads/writes.
//
// Exports:
//   selectItem(items, state)  -> { item, index, cycle, nextState }
//   validateText(text)        -> string|null  (error, or null if sendable)

/**
 * Pick the item to send for this run and compute the advanced state.
 * @param {Array<{text:string}>} items
 * @param {{next_index?:number, cycle?:number}} state
 */
export function selectItem(items, state = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('feed is empty');
  }
  const total = items.length;
  const raw = Number.isInteger(state.next_index) ? state.next_index : 0;
  const index = ((raw % total) + total) % total; // safe wrap; tolerates negatives/overflow
  const cycle = Number.isInteger(state.cycle) && state.cycle > 0 ? state.cycle : 1;

  const advanced = index + 1;
  const wrapped = advanced >= total;
  const nextState = {
    next_index: wrapped ? 0 : advanced,
    cycle: wrapped ? cycle + 1 : cycle,
  };
  return { item: items[index], index, cycle, nextState };
}

/**
 * Guard against a blank / placeholder / non-Hebrew feed entry silently shipping.
 * (All bots reply in Hebrew; a feed item with no Hebrew is almost certainly a bug.)
 * @returns {string|null} error string, or null if ok
 */
export function validateText(text) {
  if (typeof text !== 'string' || text.trim().length < 40) {
    return 'feed item text missing or too short';
  }
  if (!/[֐-׿]/.test(text)) {
    return 'feed item text contains no Hebrew';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Named selection STRATEGIES (2026-07-17 convergence). Three divergent daily-content picks existed
// across the workspaces; two collapse onto the shared strategies below (the third — poker's
// dor-lesson-dyn infinite/non-repeating `covered[]` model — is genuinely different and stays put).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * STRATEGY "rotate": plain round-robin over an ordered list, state = { next_index }.
 * SELECTION is identical to selectItem (index = next_index mod length), but the persisted state is
 * DELIBERATELY cycle-free: `nextState = { next_index }` only. This matches poker's dor-teder
 * `pickMember` byte-for-byte so its on-disk `dor-teder-state.json` format is unchanged by migration.
 * (selectItem above keeps `cycle` for the shared cron-feed CLI, which has always written it.)
 * @param {Array<any>} items
 * @param {{next_index?:number}} state
 * @returns {{item:any, index:number, nextState:{next_index:number}}}
 */
export function selectRotate(items, state = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('rotate: list is empty');
  }
  const total = items.length;
  const raw = Number.isInteger(state.next_index) ? state.next_index : 0;
  const index = ((raw % total) + total) % total; // safe wrap; tolerates negatives/overflow
  return { item: items[index], index, nextState: { next_index: (index + 1) % total } };
}

/**
 * STRATEGY "daily": day-idempotent pick with least-recently-sent recycling. Verbatim port of
 * zorro's morning.mjs `pickNext` (the SUPERIOR of the three reimplementations):
 *  - If `today` already has a sent entry → return THAT item (idempotent re-run; never burn a
 *    second item on the same day).
 *  - Else the first item never sent (list order). If every item was sent at least once, recycle
 *    the one sent longest ago (oldest last-sent date, list-order tie).
 * "State" is the append-only sent log ([{date, id}]), NOT a {next_index} file — so the caller's
 * on-disk sent.jsonl format is untouched. `idOf`/`textOf` let non-{id,text} item shapes plug in.
 * @param {Array<any>} items
 * @param {Array<{date:string,id:string}>} sentEntries
 * @param {string} today  YYYY-MM-DD (caller passes todayInTz(tz))
 * @param {{idOf?:(x:any)=>string, textOf?:(x:any)=>any}} [accessors]
 * @returns {{id:string, text:any, alreadyLogged:boolean, item:any}|null}
 */
export function selectDaily(items, sentEntries, today, { idOf = (x) => x.id, textOf = (x) => x.text } = {}) {
  if (!items?.length) return null;
  const entries = Array.isArray(sentEntries) ? sentEntries : [];

  const todays = entries.find((e) => e?.date === today);
  if (todays) {
    const it = items.find((i) => idOf(i) === todays.id);
    return { id: todays.id, text: it ? textOf(it) : null, alreadyLogged: true, item: it ?? null };
  }

  const lastSent = new Map(); // id -> latest date it was sent
  for (const e of entries) {
    if (!e?.id) continue;
    if (!lastSent.has(e.id) || String(e.date) > lastSent.get(e.id)) {
      lastSent.set(e.id, String(e.date));
    }
  }

  const fresh = items.find((i) => !lastSent.has(idOf(i)));
  const pick =
    fresh ??
    [...items].sort((a, b) =>
      (lastSent.get(idOf(a)) ?? '').localeCompare(lastSent.get(idOf(b)) ?? '')
    )[0];

  return { id: idOf(pick), text: textOf(pick), alreadyLogged: false, item: pick };
}
