# Digit ↔ company Gmail — local mirror + unreplied-mail alerts (design)

**Date:** 2026-07-15 · **Status:** approved by David (chat) · **Workspace:** `workspace-realestate/` (digit)

## Goal

Give digit durable, low-context access to the company Gmail (a regular `@gmail.com` account owned
by David & Yonatan — NOT Od Sifra's): full backlog on first run, incremental afterwards, always
current, old + new mail equally accessible. Twice a day, if new mail arrived that nobody replied
to, digit posts a Hebrew summary + recommendation to the **DY group**.

## Decisions (from brainstorm with David, 2026-07-15)

| Question | Decision |
|---|---|
| Account type | Regular `@gmail.com` (no Workspace/admin) |
| Volume | Low hundreds of emails total |
| Access level | **Read-only.** No labeling/marking (David explicitly reversed an earlier "read+label" answer) |
| Where digit may use mail content | Consultation group + DY group (both answering groups) |
| Sync cadence | Twice daily at US/IL-friendly hours (07:00 & 16:00 Asia/Jerusalem) **+ on-demand** when digit is asked about mail |
| Proactive alerts target | **DY group** ("DY - USA 🇺🇸 & ISRAEL 🇮🇱") |
| Alert filtering (grilled 2026-07-15) | **None** — David: the mailbox has no automated/marketing mail; every new unreplied mail is reported |
| Re-nag policy (grilled 2026-07-15) | **Alert once per mail** — only new-since-last-run pending threads are reported; no repeat reminders (future option: weekly digest of still-open threads) |
| Context discipline | Bodies live on disk only; digit enters via INDEX.md, opens single files. Never bulk-read |

## Auth: IMAP + App Password (not OAuth)

Repo precedent wins: `workspace-jobscout/tools/gmail-search.mjs` already does Gmail over IMAP
(`imapflow`) with `GMAIL_USER`/`GMAIL_APP_PASSWORD`, including MIME decoding and UID-incremental
state. Reuse that pattern (and its decode helpers) instead of the originally-sketched OAuth
`gmail.readonly` flow — no Google Cloud project, no 7-day testing-mode token expiry, fully
headless.

- Setup cost for David: enable 2-Step Verification on the company account → create an App Password.
- Secrets: `~/.openclaw/secrets/gmail-digit.env` (`GMAIL_USER=…`, `GMAIL_APP_PASSWORD=…`, chmod 600),
  loaded by the systemd service via `EnvironmentFile=` and by the tool via `--env-file` fallback.
  Follow the Tavily lesson: env-file / systemd drop-in, **not** SecretRef (breaks CLI infer).
- Read-only is enforced at tool level: fetch with `BODY.PEEK[]` (never sets \Seen), never call
  STORE/APPEND/EXPUNGE. IMAP has no read-only credential, so the tool is the guarantee — acceptable
  per David.

## Component 1 — `workspace-realestate/tools/gmail-sync.mjs`

Node ESM, `imapflow` dep (own `package.json` entry; copy decode helpers from jobscout's
gmail-search rather than importing across workspaces — workspaces stay isolated).

- **First run (backfill):** fetch ALL of `[Gmail]/All Mail` (hundreds — minutes). One Markdown file
  per message: `data/mail/messages/YYYY-MM-DD--<uid>.md` with frontmatter
  (`from,to,cc,subject,date,gmailThreadId,uid,attachments[name,size]`) + decoded plain-text body.
  Attachments are NOT downloaded (names/sizes only) — revisit only if needed.
- **Incremental:** state in `data/mail/state.json` (`{uidValidity, lastUid, lastSyncTs}`); fetch
  `UID lastUid+1:*`. If `UIDVALIDITY` changed → automatic full re-mirror (cheap at this volume).
- **Unreplied detection:** group All Mail by `X-GM-THRID`; a thread is *pending* when its newest
  message is inbound (From ≠ the account address). New-since-last-run pending threads are written to
  `data/mail/pending-attention.json` (`[{file, from, subject, date}]`), consumed by the alert run.
- **INDEX rebuild:** regenerate `data/mail/INDEX.md` every run — one line per mail:
  `date | from | subject | replied?✓/✗ | messages/<file>`. Newest first. This is digit's only entry
  point; hundreds of lines ≈ trivially greppable.
- Flags: `--dry-run`, `--verbose`, `--full` (force re-mirror). Errors → non-zero exit + JSON on
  stderr (watchdog-friendly).

## Component 2 — context/memory discipline (digit side)

- `AGENTS.md` (always injected) gets a short "📧 Company mail" section: mail lives in
  `data/mail/`; to answer mail questions run `node tools/gmail-sync.mjs` first (freshness), then
  grep `INDEX.md`, then open only the specific `messages/*.md` needed. **Never** bulk-read the
  messages dir. Mail content may be used ONLY in the consultation + DY groups.
- No bootstrap injection of mail content (unlike group-notes.md) — INDEX-on-demand keeps context lean.
- `skills/realestate-advisor/router.md`: add `/mail` command + Hebrew NL intents ("מייל", "מיילים",
  "אינבוקס") routing to the flow above.

## Component 3 — twice-daily sync + unreplied alert to DY group

**Revised during planning (2026-07-15): use OpenClaw's NATIVE cron, not systemd.** The proven
pattern already runs zorro-daily and the job-scout crons: isolated agent run + `announce →
whatsapp:<jid>` delivery (`openclaw cron list` shows them). One job, no systemd units:

- `openclaw cron add` job `digit-mail-check`, agent `digit`, `--cron "0 7,16 * * *"`,
  `--tz Asia/Jerusalem`, announce → the DY group jid (`1203630000000000DY@g.us`).
- The cron message tells digit: run `node tools/gmail-sync.mjs`; read
  `data/mail/pending-attention.json`; if empty → reply with the exact silent token (`NO_REPLY`,
  respected gateway-wide, nothing is sent); otherwise post ONE Hebrew message — per mail a 2–3-line
  summary + a concrete recommendation (reply/ignore/forward/act).
- Creds reach the agent's exec env via the gateway's systemd drop-in `secrets.conf` (same mechanism
  as the Tavily key); the tool also falls back to reading `~/.openclaw/secrets/gmail-digit.env`
  directly so manual shell runs work.
- Alert once per mail: pending-attention.json only ever contains new-since-last-run threads.

## Testing & safety

- `tools/gmail-sync.test.mjs` (`node --test`, no network): MIME decode, frontmatter render,
  unreplied/thread logic, INDEX generation, state round-trip, UIDVALIDITY-change fallback — fixtures only.
- No changes to WhatsApp credentials, routing/bindings, or `openclaw.json` — this feature is purely
  workspace files + secrets file + one systemd timer pair.
- Rollback: disable timer, delete `data/mail/` — nothing else is touched.

## Out of scope (YAGNI, revisit on demand)

Attachment download; vector/search index (hundreds of mails → grep suffices; the Drive-sync
precedent applies); sending/labeling mail; other agents seeing the mailbox.
