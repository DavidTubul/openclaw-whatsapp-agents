# Multi-Tenant Job-Scout — Design Spec

> Status: approved-pending-review · Date: 2026-05-30 · Author: dev session (Claude)
> Turns the single-user (David) job-scout into a generic multi-person bot where
> adding another job-seeker is "one folder + one registry row." Also folds in the
> efficiency fixes surfaced in the architecture review (Gmail incremental, ledger
> pre-filter, config-driven LinkedIn keywords, duplicate-validation cleanup).

## 1. Goal & scope

**Goal:** Let David's job-scout serve multiple people from one shared WhatsApp group.
David is the **owner** (full pipeline: search → score → Sheet tracking → Gmail status
sync → push + full conversational Q&A). Additional people are **guests** (search →
score → push + light Q&A; **no Sheet, no Gmail**). The first guest is **guest** (David's
brother — financial/AML analyst, Tel-Aviv area).

**Non-goals (YAGNI):**
- No per-guest Google Sheet or Gmail.
- No full de-hardcoding of the install root beyond the new path resolver.
- No change to the operational hardening (watchdog, ghost-mode, ack-react) or to the
  session-hygiene mechanism — it remains valid (see §3).

## 2. Decisions (locked with David)

| # | Decision | Choice |
|---|---|---|
| D1 | Architecture | **Approach A** — `people/` registry, capabilities optional per person |
| D2 | WhatsApp model | **One shared group** for everyone (David's group; he adds others) |
| D3 | Guest interaction | **Push + light Q&A** (no application tracking) |
| D4 | David file migration | **Move David into `people/david/`** (full uniformity), verify nothing breaks |
| D5 | Q&A routing | **Hook → `last-inbound.json`**, accept the rare simultaneous-typing race |

## 3. Key technical finding (why D5)

OpenClaw delivers a **group** inbound message to the agent turn as `[timestamp] text`
**without the sender identity**. The sender is available **only at the gateway-hook
level** (`ctx.metadata.senderId` / `senderE164`; `ctx.from` is the group JID — confirmed
in `tools/hooks/ack-react/handler.js`). OpenClaw *does* isolate **direct** chats per
sender natively (`agent:main:whatsapp:direct:+972…`), but DMs are currently
`dmPolicy:"disabled"` and David wants the group.

**Consequences:**
- **Scout push** is unaffected — we choose each report's recipient. ✅
- **Q&A** must attribute the message to a person via the hook. A gateway hook writes the
  current sender to `workspace/data/last-inbound.json`; the Q&A prompt reads it. Because
  turns are serialized per session but the `message:received` hook fires on receipt, a
  second message arriving mid-turn can overwrite the file → a rare misroute. Accepted
  (two brothers rarely type simultaneously; impact is one cosmetic misroute, self-evident).

**session-hygiene** (reset the shared group transcript when it grows) solves *context
bloat*, which is orthogonal to multi-tenancy. It stays as-is and remains correct.

## 4. File layout

```
workspace/
├── .config/
│   ├── job-scout.json          # shared infra: whatsapp.group_id, telegram defaults, session_hygiene (unchanged)
│   └── people.json             # NEW — the registry (§5)
├── people/
│   ├── david/                  # migrated from current top-level locations (D4)
│   │   ├── profile/{cv.pdf, cv-summary.json, profile.md}
│   │   ├── sources.json              # Tavily queries + linkedin_keywords (QA)
│   │   ├── allowed-locations.json    # center-Israel
│   │   └── data/{sent-suggestions.json, telegram-state.json, gmail-state.json}
│   └── yossi/
│       ├── profile/{cv.pdf, cv-summary.json, profile.md}   # cv.pdf/summary/profile already exist under profile/yossi/
│       ├── sources.json              # financial/AML/fraud/compliance/BI analyst queries (built from profile)
│       ├── allowed-locations.json    # Ramat HaHayal, Azrieli, Bursa-RG, Ramat HaSharon, Bnei Brak (+Remote-IL)
│       └── data/sent-suggestions.json
└── skills/job-scout/   # SHARED: SKILL.md, prompt-scout.md, prompt-qa.md, router.md, keywords.json
```

Migration moves David's current files:
`workspace/profile/*` → `people/david/profile/*`;
`skills/job-scout/sources.json` → `people/david/sources.json` (and add `linkedin_keywords`);
`skills/job-scout/allowed-locations.json` → `people/david/allowed-locations.json`;
`workspace/data/{sent-suggestions,telegram-state}.json` → `people/david/data/`.
`keywords.json` stays shared (email classification — owner only). The two
`skills/.../allowed-locations.json` + `sources.json` paths that tools currently fall
back to are removed from the tools in favor of the registry resolver.

## 5. The registry — `workspace/.config/people.json`

```jsonc
{
  "shared": {
    "whatsapp_group_id": "120363000000000000@g.us",
    "default_person": "david"
  },
  "people": [
    {
      "id": "david", "name": "David", "role": "owner", "enabled": true,
      "match_e164": [],                       // owner is matched via fromMe (own-number); see §5.1
      "capabilities": { "sheet": true, "gmail": true, "telegram": true },
      "sheet": { "webhook_url": "<from job-scout.json>", "sheet_id": "…", "sheet_url": "…" },
      "gmail": { "user": "owner@example.com" },
      "telegram": { "channels": ["IL_QA_Job"] }
    },
    {
      "id": "yossi", "name": "אורח", "role": "guest", "enabled": true,
      "match_e164": ["972500000000"],
      "capabilities": { "sheet": false, "gmail": false, "telegram": false }
    }
  ]
}
```

Per-person paths are by convention `people/<id>/{profile,sources.json,allowed-locations.json,data}`
— the registry stays lean.

### 5.1 Routing — three distinct cases (privacy-safe)

The earlier "anyone ≠ a known guest → David" default leaked David's data to strangers in
the group. Corrected to **three** cases:

1. **Owner (David):** identified by `fromMe` — the bot runs on David's own number, so his
   messages arrive as `fromMe:true` (sender E164 == the bot's own number `meta.to`; this is
   exactly how `ack-react` already detects him). Reliable without hardcoding his number.
2. **Known guest:** sender E164 ∈ some person's `match_e164` (digits-only compare) → that guest.
3. **Unknown sender:** anyone else → a **public/unknown persona** — answers only general
   questions (company info, "what is this bot"), with **no access to any person's Sheet/Gmail/
   ledger**, and a polite Hebrew note that this is a personal tool and being added needs the
   owner. Never resolves to David.

`personByE164` returns the matched person, the owner on `fromMe`, or `null` (→ unknown persona).

## 6. Tools (changes & additions)

- **`tools/lib/people.mjs`** (NEW, unit-tested): `resolvePerson(id)` (returns the person
  with absolute paths resolved), `listEnabled()`, `personByE164(e164)`. Single source of
  truth for per-person paths; replaces the hardcoded `SOURCES_PATHS`/`LOCATIONS_PATHS`
  arrays in `search.mjs`/`telegram.mjs`.
- **`tools/ledger.mjs <person> <check|add>`** (NEW, unit-tested): reads/writes
  `people/<id>/data/sent-suggestions.json`.
  - `check` reads stdin/arg list of `{company,role}` (or jobkeys) → prints which are
    already sent (the pre-score filter).
  - `add` appends `[{id,url,title,company,date}]`, de-duped by `id` (replaces the inline
    `node -e` block in prompt-scout Step 7b).
- **`search.mjs --person <id>`**: loads that person's `sources.json` +
  `allowed-locations.json`. `linkedin_keywords` move from the hardcoded `LINKEDIN_KEYWORDS`
  const into each `sources.json`.
- **`telegram.mjs fetch --person <id>`**: per-person channels (registry/`sources.json`) and
  per-person `data/telegram-state.json`. Guest with `telegram:false` → skipped by the prompt.
- **`gmail-search.mjs --person <id>`** (owner only): reads `people/<id>/data/gmail-state.json`,
  fetches with `--after-uid <last_uid>` (first run → fallback `--days 2`), writes back the
  max UID seen. Eliminates the daily 48-hour re-fetch. The existing `--uid`/`--after-uid`/
  `--days` flags are retained for ad-hoc/manual use.
- **`sheet.mjs`**: unchanged behavior; owner-scoped (only `capabilities.sheet:true` people
  call it). Reads webhook from the person's registry entry (falls back to `job-scout.json`).

## 7. Scout pipeline — `prompt-scout.md`

Wrap the existing steps in a loop over `listEnabled()`:

```
for each person p in listEnabled():
  load p.profile/cv-summary.json, p.sources, p.locations
  Step1   search.mjs --person p.id            (+ Step1b telegram.mjs fetch --person p.id  IF p.capabilities.telegram)
  Step1c  LinkedIn open-check — REMOVED from the prompt (search.mjs already does it); keep only the
          "could not verify → ⚠️ note" guidance for non-LinkedIn edge cases
  Step2   score candidates vs p's CV summary (unchanged reasoning) + normalize (2b)
  Step3   dedup:
            ledger.mjs p.id check  → drop candidates already sent           (ALWAYS, pre-score-friendly)
            IF p.capabilities.sheet: also dedup against the Sheet (existing 3a–3c)
            ELSE: the ledger IS the dedup set
  Step4   IF p.capabilities.sheet: append new rows to the Sheet; ELSE: skip (ledger is the record)
  Step5   IF p.capabilities.gmail: Gmail status sync (existing Step 5/5b, now via gmail-search --person p.id)
  Step6   compose p's report, labeled with p.name (owner = full portfolio; guest = "🆕 משרות חדשות עבורך" only)
  Step6b  IF p.capabilities.sheet: sheet.mjs sort
  Step7   send to the shared group_id (one message per person)
  Step7b  ledger.mjs p.id add   (record the jobs just sent)
  Step8   per-person run log → data/runs/<date>-<id>.json
  Rule 6 applies per-person: 0 new AND (owner: 0 status changes) → send nothing for that person.
```

Report format — **guest** (no Sheet): header `🔵 בוקר טוב {name}!`, then only the
`🆕 משרות חדשות עבורך` block (skip "תיק הגשות" / "משרות פתוחות" / Sheet link). **Owner**:
unchanged.

**Always send a daily message to every enabled person** (David's explicit requirement —
overrides the old per-person Rule 6 skip). If a person has **0 new jobs** (and, for the
owner, 0 status changes), still send a short Hebrew "אין משרות חדשות היום" line so each
person gets a daily heartbeat. The owner already always sends (Step 6); guests now do too.

## 8. Conversational Q&A — `prompt-qa.md`

1. Read `workspace/data/last-inbound.json` → resolve via §5.1 (owner / known guest / unknown).
2. **owner (David):** full Q&A exactly as today (status/list/הגשתי/links/Sheet) + admin (§8.1).
3. **guest (guest):** light Q&A — company info (`web search`), "show me today's/my recent
   jobs" (from `people/<id>/data/sent-suggestions.json` + `RECENT_CHAT.md`). A Sheet-only
   request → polite Hebrew reply that he has no application tracker. **No access** to
   David's Sheet/Gmail or any other person's data (isolation).
4. **unknown sender:** public persona — general questions only, no private data, gentle
   "this is a personal tool; ask the owner to add you" note. Never David's data.
5. The self-modification approval rule (SKILL.md rule 8) is unchanged.

### 8.1 Owner-only people administration

The owner can manage people from chat (a guest/unknown asking is refused). Implemented as
edits to `workspace/.config/people.json` (a normal workspace config the agent may edit — not
secrets/OAuth/gateway/channels), effective on the next run/message.

| Command | Action |
|---|---|
| `/people` | list people (id, name, role, enabled) |
| `/disable <id>` | set `enabled:false` — **default meaning of "delete/remove someone"** (reversible) |
| `/enable <id>` | set `enabled:true` |
| `/add …` | adding a person needs profile + CV files → reply that this needs a dev session |

"Delete" defaults to **disable** (reversible), mirroring the "never delete a Sheet row"
philosophy. A **hard delete** (remove the `people/<id>/` folder + registry row) happens only
on explicit confirmation ("כן, מחק לגמרי"). Hebrew NL equivalents ("תמחק את X" / "תעצור
ל-X" / "תחזיר את X") map to the same actions via `router.md`.

## 9. Hooks

- **`chat-log`**: extend `decideLog` to capture the real sender from
  `ctx.metadata.senderE164` (today it hardcodes `from:"david"`). (a) write
  `workspace/data/last-inbound.json = {e164, ts}` on each received message; (b) label
  RECENT_CHAT records by resolved person name (David / אורח / Scotty). Stays best-effort
  (never throws). Unit tests updated.
- **`ack-react`**: unchanged (already participant-aware).

## 10. guest content to author

- `people/yossi/sources.json` — Tavily queries for Financial / AML / Fraud / Compliance /
  Data / BI / Intelligence Analyst roles at financial institutions; empty `linkedin_keywords`
  or finance-specific ones; no telegram channel initially.
- `people/yossi/allowed-locations.json` — allow: רמת החייל, עזריאלי, בורסה רמת גן,
  רמת השרון, בני ברק (+ Remote-IL); block: the rest (incl. David's center-Israel cities he
  doesn't want — keep per-person).
- `people/yossi/profile/{cv.pdf,cv-summary.json,profile.md}` — move the existing
  `profile/yossi/*` files here.

## 11. Docs to update

- `CLAUDE.md` — replace the single-user "David / search profile" + config sections with the
  multi-tenant model, the registry, the routing finding, and the efficiency changes.
- `SKILL.md` — generalize "David Tubul's assistant" → owner + guests; update mode routing and
  the tool table (`--person`, `ledger.mjs`, gmail-state); generalize hard rule 1 to
  "shared group only."
- Fix the cron drift: `job-scout.json.schedule_cron` and the docs must agree with the actual
  cron (08:00 Asia/Jerusalem per `data/runs/*`). Confirm against `openclaw cron get`.

## 12. Risks & verification

- **David migration (D4)** — the one regression risk. Mitigation: update every reference
  (prompts, tools, hooks, CLAUDE.md), then run the full test suite (43 tests) + `search.mjs
  --person david` (dry) + `sheet.mjs ping` + `gmail-search.mjs --person david` + a dry scout
  reasoning pass. Keep a backup of moved files.
- **David's E164** — left `[]` initially (matched as default owner); fill once observed in
  `last-inbound.json` / ack-react debug. Routing is correct meanwhile (anyone ≠ guest → David).
- **Race in D5** — documented & accepted.
- **Tests** — `people.mjs`, `ledger.mjs`, chat-log sender capture, gmail-state increment all
  get unit tests; existing tests kept green.
- **Not a git repo** — design doc saved to disk; no commit (repo is not under git).

## 13. Out of scope / future

- Per-guest Sheet/Gmail (if a guest later wants tracking).
- A finance-jobs Telegram channel for guest.
- Enabling DMs for race-free Q&A (revisit if the shared-group race ever bites).
- Full install-root de-hardcoding.
