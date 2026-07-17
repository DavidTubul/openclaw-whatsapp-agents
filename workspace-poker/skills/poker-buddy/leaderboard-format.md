# Leaderboard display format (David-approved 2026-07-01)

When showing the lifetime leaderboard (`poker.mjs leaderboard`), render it with icons instead of a
plain numbered list. Structure per row: `<icon> <rank>. <display name> (<sessions> ערבים) — <net>₪`.

The sessions count comes from the `sessions` field `poker.mjs leaderboard` already returns per
player (derived live from the ledger) — never store a session count in `players.json`, it would go
stale the moment a new night is recorded. Identity/display fields (nickname, icon) belong in
`players.json`; anything ledger-derived (net, sessions, wins/losses) always comes from the tool.

Hebrew grammar: `sessions === 1` → "ערב אחד", otherwise → "<N> ערבים".

## Source of truth: `data/players.json`

Per-player display fields live on the player record in `data/players.json` (gitignored — real
names/nicknames NEVER belong in this file), NOT duplicated here:
- `nickname` (optional) — shown as `<name> (<nickname>)` if present, else just `<name>`.
- `icon` (optional) — this player's personal icon, always shown, replacing the generic tier icon
  (except when the rank-overlay rule below applies).
- `lastPlaceNickname` / `lastPlaceIcon` (optional) — only apply when this player is currently in
  last place; overrides `nickname`/`icon` for that row only (used for a running group joke —
  cosmetic display only, still not an enforced real rule; configured only in `players.json`).

If David adds/changes a nickname or icon later, edit `data/players.json` directly (Path B edit) —
never hand-maintain a second copy of this table in markdown.

## Icon rules (rank overlay, applied top-down)

1. **#1 (top, highest net):** leading icon is always 👑, regardless of personal icon. The player's
   own `icon` (if any) still shows after the name, e.g. `👑 1. אבי כהן (המלך) 💰 — +990₪`.
2. **Last place (bottom, lowest net):** leading icon is the player's `lastPlaceIcon` if set, else 📉.
3. **#2–#3 (not covered by rule 1):** 🥈 🥉.
4. **Everyone else:** the player's own `icon` field if set; otherwise 📈 for positive net / 📉 for
   negative net.

## Bidi note

Never use a flag emoji (regional-indicator pair, e.g. 🇮🇳) in these rows — flags are strongly LTR in
Unicode bidi and flip the whole RTL line visually broken on WhatsApp. Use a non-flag pictograph
instead (e.g. 👳 instead of a flag). This bit David on 2026-07-01.

## Example (fictional data — real names/amounts live only in gitignored `players.json`/`sessions.json`)

```
👑 1. אבי כהן (המלך) 💰 (5 ערבים) — +990₪
🥈 2. בני לוי (4 ערבים) — +410₪
🥉 3. גדי רון (ערב אחד) — +220₪
👨‍💻 4. דוד (3 ערבים) — +155₪
📈 5. הילה (4 ערבים) — +120₪
📉 6. ואדים (ערב אחד) — -150₪
🙏 7. זיו (ערב אחד) — -200₪
👜 8. חנן (2 ערבים) — -258₪
👳 9. טל (ערב אחד) — -300₪
😭 10. יובל (הנעלב) (4 ערבים) — -330₪
🧦 11. כפיר (גרביים ורודות) (5 ערבים) — -657₪ 😬
```

## Hidden players

If a player's `players.json` record has `"hidden": true`, exclude them from the displayed
leaderboard (renumber ranks around the gap) — but NEVER delete their ledger data, sessions, or the
`players.json` record itself (red line: don't erase players/sessions without explicit confirmed
request). This is a display-only filter for people who don't play regularly (e.g. a one-time guest,
hidden per David).

If a hidden player's `sessions` count (from `poker.mjs leaderboard`) goes up since they were hidden
— i.e. they played again — unhide them (remove `hidden`/`hiddenNote` from their record) before
showing the next leaderboard, so they reappear automatically.

## Notes

- Always pull the net/rank numbers from `poker.mjs leaderboard` — this file only controls
  presentation, never the numbers.
- Players with no `nickname`/`icon` in `players.json` just get the tier icon and their plain name.
