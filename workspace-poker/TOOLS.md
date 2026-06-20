# TOOLS.md — Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff unique to this setup.

## The poker tool

- `node tools/poker.mjs <cmd>` — the deterministic ledger (players, sessions, money, settle-up, stats). Run from `workspace-poker/`. Full command list in `AGENTS.md`.
- Data lives in `data/players.json` + `data/sessions.json`. `POKER_DATA_DIR` env overrides the data dir (used by tests only).
- Tests: `node --test tools/lib/*.test.mjs`.

## Notes to fill in over time

```markdown
### Stakes
- Standard buy-in: ____ ₪
- Re-buy: ____

### Settle-up
- Group settles via: ____ (cash / Bit / PayBox)
```

Add whatever helps you do the job — this is your cheat sheet.
