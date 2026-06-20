# Job-Scout Optimization — Design

> Date: 2026-05-26. Goal: make Scotty work better and cheaper by matching the
> model to each task and tightening the scout pipeline. Approved by David.

## Background / findings

- **Billing:** the runtime authenticates via `~/.claude/.credentials.json`
  `claudeAiOauth` — `subscriptionType: team`, `rateLimitTier: default_claude_max_5x`.
  So cost is **rate-limit bound, not per-token**. A once-daily Opus scout is
  effectively free at the margin (shared budget with David's interactive Claude Code use).
- **The skill's declared model is ignored.** `SKILL.md` frontmatter
  `model: anthropic/claude-opus-4-7` + `fallback_models:` are **not parsed** by the
  OpenClaw runtime. Actual model resolution:
  - **cron job** (`~/.openclaw/cron/jobs.json`, id `5d7587f3-…`): `model:null`,
    `thinking:null` → falls back to the default.
  - **default** (`~/.openclaw/openclaw.json` `agents.defaults.model.primary`):
    `anthropic/claude-sonnet-4-6`.
  - WhatsApp conversational sessions inherit the same default.
  - Net: both the heavy scout and the light chat ran on Sonnet 4.6 with default
    thinking — **no tiering**.
- **CLAUDE.md runtime notes were inaccurate**: it claimed `--effort medium` and
  `bypassPermissions`; the real cron flag is `--thinking`, and bypassPermissions is
  not actively set by OpenClaw.

## Model strategy (the headline change)

| Task | Model | Thinking | Rationale |
|---|---|---|---|
| Daily scout (cron, 1×/day) | `anthropic/claude-opus-4-7` | `high` | Heavy agentic pipeline; CV-match quality matters most here; near-free on a Max-5x subscription at 1 run/day. |
| WhatsApp Q&A | `anthropic/claude-sonnet-4-6` (unchanged default) | `low` (chat default) | Fast, good Hebrew, strong enough for intent parsing + self-mod planning. Haiku rejected: too weak for nuanced Hebrew / self-modification. |

Set via `openclaw cron edit <id> --model … --thinking high`. The chat side already
resolves to the Sonnet default — no config change needed there.

## Workstreams

1. **Model tiering + docs.** Patch the cron job to Opus 4.7 / high thinking.
   Remove the misleading `model:`/`fallback_models:` keys from `SKILL.md` and add a
   one-line note on where the model actually comes from. Correct the CLAUDE.md runtime section.
2. **Holistic CV match.** `prompt-scout.md` Step 2 currently forces a rigid
   +20/+10/−30 arithmetic rubric onto the LLM — wrong for a strong reasoner. Replace
   with a holistic 0–100 fit judgement + Hebrew reason, keeping the rubric as
   *guidance* (signals to weigh), not arithmetic. Keep the same keep-rule
   (`level ∈ {senior,mid}` OR `score ≥ 70`).
3. **Dedupe consistency.** Step 3 dedupes only against Sheet ids, but the cron
   message + CLAUDE.md reference `data/sent-suggestions.json`. Dedupe against **both**,
   and append newly-sent jobs to the ledger after Step 7 send. Ledger shape:
   `{"sent":[{id,url,title,company,date}, …]}`.
4. **Fewer Sheet reads.** The Sheet is read 3+ times per run (ids, read, read).
   Read once early, derive existing ids + status counts from that snapshot, re-read
   only after writes that change it.
5. **Search recall.** `sources.json` is Senior-heavy (7 queries) vs Mid (2) though
   David accepts Mid. Add Mid / SDET queries across the existing boards.

## Out of scope / non-goals

- No changes to secrets, OAuth scopes, channels, or gateway config.
- No change to the Sonnet chat default (keeping quality for Hebrew + self-mod).
- Hard rules unchanged (group-only sends, read-only Gmail, no row deletes, no applying).

## Verification

- `openclaw cron get <id>` shows model `anthropic/claude-opus-4-7`, thinking `high`.
- `node tools/sheet.mjs ping` still ok.
- `node tools/search.mjs` still returns candidates (new queries don't break the filter).
- Manual debug run (`openclaw cron run <id>` or a `scout` session) produces a sane
  Hebrew report and updates the ledger.
