# Cross-source dedup + uniform job presentation — Design

**Date:** 2026-05-27
**Status:** Approved (design); pending implementation plan
**Author:** Scotty dev session (David Tubul / OpenClaw)

## Problem

The scout now pulls from three sources (LinkedIn, Tavily boards, Telegram). The same job often
appears in more than one source with a **different URL** per platform. The current dedup is purely
`sha256(url)`, so:

1. The same job from Telegram and LinkedIn lands as two rows (different URLs → different ids).
2. The Gmail Step 5b path appends "applied" rows that already exist under another source (observed
   2026-05-26: 9 duplicate rows added, then hidden as `⛔ Not Interested`).
3. Presentation is inconsistent — Telegram posts are free-text Hebrew, so role/company/location can
   be messy compared with board-sourced rows.

David's requirements: **no duplicates regardless of source**, and **uniform presentation in the
Sheet** for every job whatever its origin.

## Goal

Replace URL-based dedup with **content-based** dedup keyed on **company + role**, record a single row
per job that lists **all** sources it appeared in, and normalize every row to a canonical
presentation before writing.

## Decisions (from brainstorming)

- **Multi-source handling:** one row per job; the `source` column lists all sources (e.g.
  `linkedin + telegram`); keep the best apply URL as primary and the Telegram permalink as a
  secondary link.
- **Identity key:** **company + role**. Same company + same (normalized) role = duplicate. Different
  roles at the same company stay separate.
- **Matching strategy:** two layers — a deterministic content id for exact/future-run dedup, plus
  LLM semantic matching as a safety net against wording differences and legacy URL-id rows.
- **No Sheet schema change** — reuse existing columns; no Apps Script edit.
- **No backfill** of existing rows (YAGNI); fix applies going forward.

## Architecture

### New tool: `workspace/tools/jobkey.mjs`

Deterministic content-key generator so the LLM computes ids consistently.

```
node jobkey.mjs "<company>" "<role>"   ->  prints a 12-char id
```

- `normalize(s)`: lowercase; strip company suffixes (`בע"מ`, `ltd`, `inc`, `llc`, `ltd.`); remove
  emojis and punctuation; collapse whitespace; trim.
- `id = sha256(normalize(company) + "|" + normalize(role)).slice(0, 12)`.
- Empty company OR empty role → exit non-zero with a clear stderr message (caller must supply both).

### No Sheet schema change — column reuse

| Col | Field | Change |
|---|---|---|
| A | `id` | Now the **content key** from `jobkey.mjs` (was `sha256(url)`). |
| C | `מקור` (source) | Distinct sources joined with ` + ` (e.g. `linkedin + telegram`). |
| J | `קישור` (link) | Best apply URL — prefer a board/company URL over a Telegram permalink. |
| M | `הערות` (notes) | Secondary links appended, e.g. `גם בטלגרם: <permalink>`. |

Legacy rows keep their old URL-based ids; cross-run matching against them relies on the LLM semantic
layer. New rows use content ids, so dedup becomes eventually consistent.

## Data flow (pipeline changes in `prompt-scout.md`)

### Step 3 — rewritten: content-based, two-layer dedup

1. **Read full existing rows** via `node sheet.mjs read` (not `ids`). Capture per row:
   `id, company (E), role (D), source (C), url (J), status (K)`.
2. **Intra-batch merge:** cluster this run's kept candidates by (company + role) using LLM semantic
   judgment. Merge each cluster into ONE canonical candidate:
   - `source` = distinct union joined with ` + `.
   - primary `url` = best apply link (board/company URL preferred over Telegram permalink).
   - secondary links → notes (`גם בטלגרם: <permalink>` etc.).
   - keep the highest `score` and its `reason`.
3. **Cross-existing dedup:** for each canonical candidate compute its id via
   `node jobkey.mjs "<company>" "<role>"`, and also semantically check company+role against the rows
   read in step 1.
   - **Match found, candidate has a source not yet listed in that row** → `node sheet.mjs update <row>`
     to add the source to col C and append the secondary link to col M (notes). Do NOT resend to
     WhatsApp.
   - **Match found, no new source** → drop.
   - **No match** → genuinely new → append in Step 4 with the content id.

### Step 4 — append

Append new canonical rows with: content `id` (from `jobkey.mjs`), normalized fields (see below),
joined `source`, primary `url`, secondary links in notes.

### Step 5b — Gmail dedup fix

Before appending a Gmail "applied" row, match by **company + role** against the existing rows (not by
URL hash). If a row matches → `sheet.mjs update` its status to `✅ Applied` (+ applied_at,
email_snippet) instead of appending a duplicate row.

## Uniform presentation (normalize before writing any row)

Regardless of source:

- **תפקיד (D):** clean canonical title — no emojis, company name, location, dates, or marketing
  text. From free-text Telegram posts, the LLM extracts just the role (e.g. a long post →
  `QA Automation Team Leader`). Consistent terminology: `QA Automation Engineer`,
  `Senior Automation Engineer`, `SDET`, etc.
- **חברה (E):** clean name without `בע"מ`/`Ltd`/`Inc` and without emojis.
- **מיקום (F):** one canonical city (the matched allowed-city); remote → `Remote-IL`; unknown →
  blank (never guess).
- **רמה (G):** `senior` / `mid` as today.
- **ציון/נימוק (H/I):** Hebrew reason, 1–2 sentences, same format for all sources.
- **קישור (J) / הערות (M):** primary + secondary links as in the column table.

Because the WhatsApp report (Step 6) already renders from these fields, this also makes every job
display uniformly in WhatsApp regardless of source.

## Error handling

- `jobkey.mjs` with a missing company or role → non-zero exit + stderr message; the scout then falls
  back to the LLM semantic match for that candidate and logs the gap to stderr (does not crash the
  run).
- If `sheet.mjs read` fails, Step 3 degrades to the previous behavior for that run (append without
  cross-existing merge) rather than crashing — log to stderr.

## Testing

- `jobkey.mjs` unit test (`node --test`): same company+role in different casing/suffix/emoji forms →
  identical id; different roles at same company → different ids; missing arg → non-zero exit.
- Manual: re-run scout; confirm a job present in both Telegram and a board produces ONE row with
  `source = "... + telegram"` and a secondary link in notes; confirm a Gmail "applied" email for an
  existing company updates the row instead of adding one.

## Out of scope (YAGNI)

- Back-normalizing or re-keying existing Sheet rows.
- Any Apps Script / Sheet schema change.
- Fuzzy matching across different companies (only same-company duplicates are considered).
