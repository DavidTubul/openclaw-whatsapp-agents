# Real-time Gmail Status Watcher — Design

> Status: **proposed** · Date: 2026-05-30 · Owner: dev session (Scotty / OpenClaw)
> Goal: detect job-application status from David's Gmail (applied / interview / rejected / offer)
> within ~10 minutes of the email arriving, and update the Google Sheet automatically — instead of
> only at the 08:00 daily scout. Must run at near-zero cost.

## Problem

Today Gmail status sync (the owner-only step that reads David's inbox and updates the tracker's
status column) runs **only inside the 08:00 daily scout**. So if David applies / gets rejected /
gets an interview invite at 09:00, the Sheet doesn't reflect it until the next morning. David wants
this to be effectively real-time, but cheap.

## Cost reality (why this is feasible cheaply)

Everything runs on David's Claude **Max subscription via OAuth** (rate-limit bound, **not** per-token
billing — see CLAUDE.md "Agent runtime"). The pipeline is mostly free:

| Stage | Cost |
|---|---|
| Poll Gmail (`gmail-search.mjs`, IMAP, incremental via UID cursor) | **free** — no LLM |
| Regex pre-filter for relevance (`keywords.json`) | **free** — pure regex |
| Sheet update (Apps Script webhook) | **free** |
| Final classification (read body, decide status, match row) | LLM — but only when a *new relevant* email actually arrives, batched, on the subscription |

The only LLM step is classification, and it's needed because **subjects lie** (Comeet/Greenhouse
rejections read like "Thank you for applying…"); the body must be read to avoid mislabeling a
rejection as "applied" (see `keywords.json` `_note` and the email-classification memory). That step
fires only when there is ≥1 new relevant email — often zero per 10-minute window — and is batched
into a single call.

## Goals

1. Detect new Gmail status signals (applied / interview / rejected / offer) within ~10 min.
2. Auto-update the matching Sheet row; for ambiguous cases, ask David instead of guessing.
3. **Notify only when something actually changed** (or when input is needed) — silent otherwise.
   No heartbeat, no "checked, found nothing" message (this differs from the daily scout, which
   always sends a heartbeat).
4. Near-zero cost: free deterministic stages; LLM only on real new relevant mail, batched.
5. Honor all hard rules: owner-only (David only), Gmail read-only, sends only to `group_id`,
   never delete a Sheet row.

## Non-goals

- Instant (sub-second) push via IMAP IDLE — explicitly deferred; 10-min polling is "real-time enough"
  and far simpler. (Decision: polling timer, per the brainstorm.)
- Any Gmail watching for guests (e.g. אורח) — guests have no Gmail capability.
- Changing how the daily scout searches/pushes jobs.

## Architecture (recommended approach: standalone watcher, LLM as stateless classifier)

### New components

1. **`workspace/tools/gmail-watch.mjs`** — the watcher. Run by a systemd timer every 10 min.
   Orchestrates the free deterministic stages and the sheet writes / WhatsApp send itself; uses the
   LLM only as a pure classification function.
2. **systemd user units** `openclaw-gmail-watch.{service,timer}` — same pattern as the existing
   `openclaw-session-hygiene.timer` (proven, restart-free, survives upgrades).
3. **`workspace/people/david/data/gmail-watch-state.json`** — the watcher's **own** UID cursor,
   separate from the scout's `gmail-state.json`, so the two never race.

### Per-tick flow

1. **Resolve owner only.** Run for `david` (owner, `capabilities.gmail = true`). Never for guests.
2. **Fetch new mail** since the watcher cursor (reuse `gmail-search.mjs` incremental logic; envelopes
   only — subject/from/date/uid). *Free.*
3. **Regex pre-filter** with `keywords.json`: drop `noise_to_ignore`; keep messages whose subject (or
   known ambiguous-subject templates) suggests a status signal. *Free.*
4. **If zero relevant new emails → exit silently** (advance cursor, no message). This is the common
   case and costs nothing beyond the IMAP poll.
5. **If ≥1 relevant email:**
   a. Read current Sheet rows + statuses (`sheet.mjs read`).
   b. For relevant emails, fetch decoded bodies (`gmail-search.mjs --uid`) where needed.
   c. **One LLM call** (`openclaw infer model run --model anthropic/claude-sonnet-4-6 --json`,
      subscription OAuth, stateless): input = the new emails (subject + body) + the current Sheet
      rows; output = JSON array `[{ uid, row, status, applied_at?, note, confidence }]`. The LLM does
      classification (body-aware) **and** row matching (which job each email refers to) in one shot.
6. **Apply results (script side, deterministic):**
   - `confidence` high → `sheet.mjs update <row> { status, applied_at?, notes? }`. Idempotent
     (re-applying the same status is harmless; never downgrades an already-correct row because the
     LLM is shown current statuses).
   - `confidence` low / ambiguous / no row match → **do not guess**; queue a WhatsApp question.
   - Never create a duplicate row here; if no row matches a genuine new application, leave it for the
     existing conversational "enrich-or-add" flow (or note it in the message). (Open question below.)
7. **Notify (only if something happened):**
   - ≥1 update applied → one short Hebrew summary to `group_id`, e.g.
     `✅ עדכנתי: משרה 7 (חברה) → נדחתה`.
   - ambiguous case(s) → one Hebrew question to `group_id`, e.g.
     `📩 הגיע מייל מ-X על משרה 7 — נראה כמו דחייה, לעדכן? (כן/לא)`. David's reply is handled by the
     existing conversational Q&A (`prompt-qa.md` row-marking), no new reply path needed.
8. **Advance cursor** only over successfully processed emails.

### Accompanying change: scout no longer owns Gmail status sync

Move Gmail status detection **out of the 08:00 scout** and make the watcher its sole owner. This
avoids double-processing and a two-cursor race. The daily scout keeps job search + CV match + push +
the daily heartbeat; it stops reading Gmail for status. (The watcher already covers status
continuously, so the morning run loses nothing.)

> Note: this also means the email-classification logic currently described in `prompt-scout.md` moves
> conceptually into the watcher. `keywords.json` stays the shared classification reference.

## Data flow

```
timer (10m) → gmail-watch.mjs
  → gmail-search.mjs (IMAP, incremental, cursor=gmail-watch-state.json)   [free]
  → regex filter (keywords.json)                                          [free]
  → (if ≥1) sheet.mjs read + gmail-search.mjs --uid (bodies)              [free]
  → infer model run (classify + match → JSON)                            [subscription, batched]
  → sheet.mjs update <row> {...}                                         [free]
  → (only if changed/ambiguous) openclaw message send → group_id          [free]
  → write gmail-watch-state.json
```

## Error handling

- IMAP failure → log, exit, **don't advance cursor**; retry next tick.
- LLM call failure → log, **don't advance cursor** for unclassified emails; retry next tick. Sheet
  updates are idempotent, so a retry that re-processes an already-updated email is safe.
- Sheet webhook failure on a given row → leave that email's cursor unadvanced; others proceed.
- Overlap guard: a lightweight lock (or skip-if-running) so two ticks can't run concurrently
  (10-min interval makes this rare, but the run may occasionally exceed it on a busy batch).
- Never restart the gateway (per the chat-reliability rule); the watcher is fully out-of-process.

## Testing

- `gmail-watch.mjs --dry-run` → prints what it *would* update + the messages it *would* send, writes
  nothing and sends nothing (mirrors `session-hygiene.mjs --dry-run`).
- Unit-level: feed canned email fixtures (a clear "application received", a Comeet rejection with a
  confirmation-style subject, an interview invite, pure noise) and assert the classification +
  the chosen Sheet row + that noise produces zero output / zero messages.
- Idempotency: run twice on the same batch → second run produces no new updates and no message.
- Owner-only: assert it never runs for a guest id.

## Hard-rule compliance

1. Sends only to the configured `group_id`. ✓
2. Gmail read-only (IMAP fetch only; never modify/label/reply). ✓
3. Never deletes a Sheet row (status updates only). ✓
4. Never applies to jobs. ✓
5. Hebrew to the user; English internal. ✓
6. (Scout heartbeat rule is unchanged; the watcher is intentionally silent when idle — goal 3.) ✓
7. Source URLs: status-update messages reference the job row; no new job links surfaced here. ✓
8. Owner-only (David); never for guests/unknown. ✓

## Open questions (to settle in the plan)

1. **Genuine new application with no matching Sheet row** (David applied to something the scout never
   surfaced, and the confirmation email arrives): auto-append a new row, or just notify David and let
   the existing conversational enrich-or-add handle it? Leaning **notify-only** to avoid duplicate/
   low-quality rows from the watcher. — RESOLVE IN PLAN.
2. **LLM invocation mechanism**: `openclaw infer model run --json` (stateless, preferred) vs a
   dedicated `openclaw agent --session-key gmail-watch` session. Confirm `infer model run` cleanly
   returns parseable JSON on the subscription profile. — VERIFY IN PLAN.
3. **Cursor migration**: seed `gmail-watch-state.json` from the current `gmail-state.json` last_uid so
   the first watcher run doesn't reprocess history. — RESOLVE IN PLAN.
