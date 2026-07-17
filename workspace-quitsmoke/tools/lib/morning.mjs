// morning.mjs — pure logic for זורו's ☀️ morning kick (content selection).
//
// No I/O, no clock — the caller passes the content.md text, the sent-log entries,
// and `today`. This is what makes selection deterministic and unit-testable; the
// CLI wrapper (../morning-kick.mjs) does the file I/O around these.
//
// WHY this exists: with cron `announce` delivery the agent's FINAL turn text is
// what gets posted to the group. Leaving item-selection + sent.jsonl bookkeeping
// to the model led it to NARRATE a status report ("בעיטה נשלחה ✅…") as its final
// text — which announce then posted instead of the real content. Doing the
// deterministic parts here means the model only has to REPHRASE one fact in voice.

import { selectDaily } from "../../../shared/lib/cron-feed.mjs";

/** Parse content.md → ordered [{id, text}] for every "- `id` — text" bullet. */
export function parseContent(md) {
  const items = [];
  // bullet shape in content.md:  - `fact-8m` — <hebrew text>
  const re = /^-\s+`([^`]+)`\s+[—-]\s+(.+?)\s*$/;
  for (const line of String(md ?? "").split("\n")) {
    const m = line.match(re);
    if (m) items.push({ id: m[1].trim(), text: m[2].trim() });
  }
  return items;
}

/**
 * Choose the morning item deterministically.
 *  - If `today` already has a sent entry → return THAT item (idempotent re-run;
 *    never advance/burn a second item on the same day).
 *  - Else the first item never sent (file order). If every item was sent at least
 *    once, recycle the one sent longest ago (oldest last-sent date, file-order tie).
 * Returns { id, text, alreadyLogged } or null when there are no items.
 */
export function pickNext(items, sentEntries, today) {
  // Delegates to the shared `daily` strategy (this exact algorithm was ported into it verbatim).
  // Preserve pickNext's 3-key contract ({id,text,alreadyLogged}) — strip selectDaily's extra `item`.
  const r = selectDaily(items, sentEntries, today);
  if (!r) return null;
  return { id: r.id, text: r.text, alreadyLogged: r.alreadyLogged };
}
