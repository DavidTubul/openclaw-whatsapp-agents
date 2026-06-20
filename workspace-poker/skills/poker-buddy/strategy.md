# strategy.md — דילר's poker coaching knowledge

Read this for any strategy / odds / "how should I play" question. Assume **No-Limit Texas Hold'em**
(the default home game) unless the user says otherwise. Answer in Hebrew, concise and concrete:
give the number/line + one line of *why*. Always be honest that poker is variance — teach the math,
don't promise results.

## Pot odds & equity (the core math)

- **Pot odds** = call size ÷ (pot after your call). Call if your **equity** (chance to win) ≥ pot odds.
  - Example: pot 100, opponent bets 50 → you call 50 into 200 → pot odds = 50/200 = **25%**. Call if
    you win ≥25% of the time.
- **The Rule of 2 and 4** (quick equity from outs):
  - On the **flop** with two cards to come: equity ≈ **outs × 4%**.
  - On the **turn** with one card to come: equity ≈ **outs × 2%**.
- **Common draws & outs:**
  - Flush draw = **9 outs** → ~36% by river (flop), ~19% (turn).
  - Open-ended straight draw = **8 outs** → ~32% / ~17%.
  - Gutshot = **4 outs** → ~16% / ~9%.
  - Flush draw + OESD (combo) = ~15 outs → ~54% / ~33% (often a favorite!).
  - Two overcards = ~6 outs → ~24% / ~13%.
- **Implied odds:** a draw can be a +EV call even below pot odds if you'll win a big bet when you hit.
  Reverse implied odds: discount hands that make a *second-best* hand (e.g. weak flush).

## Preflop hand strength (cash, 6-9 handed)

- **Premium (raise/3-bet from anywhere):** AA, KK, QQ, JJ, AKs, AKo.
- **Strong (open most positions):** TT-99, AQ, AJs, KQs, ATs.
- **Playable, position-dependent (open late / call):** small-mid pairs (22-88), suited connectors
  (T9s-54s), suited aces (A2s-A9s), KJ/QJ/JTs.
- **Position is power:** open tighter from early position (UTG), wider from the button/cutoff.
  In position you act last every street — huge edge. Play more hands IP, fewer OOP.
- **Pairs set-mining:** small pair calling a raise wants ~15-20× the call in implied odds (you flop
  a set ~1 in 8.5). Otherwise fold OOP.

## Betting & lines

- **Bet for value or as a bluff** — not "to see where you're at." Value: get called by worse. Bluff:
  fold out better.
- **C-bet** (continuation bet) more on **dry** boards (K-7-2 rainbow) you can represent; check more on
  **wet** boards that hit caller ranges (9-8-7 two-tone).
- **Sizing:** typical c-bet ~1/3–2/3 pot; bigger on wet boards / for value with strong hands; smaller
  on dry boards. Consistent sizing across value+bluffs is harder to read.
- **3-bet** premiums for value and some suited blockers (A5s, KQs) as semi-bluffs; flat strong pairs
  in position.
- **Pot control:** check back medium-strength hands to avoid bloating the pot OOP.

## Common spots (quick guidance)

- **Top pair, decent kicker, raised on a wet board:** proceed cautiously — pot control, don't stack off
  light. One pair is one pair.
- **Flush/straight draw facing a bet:** compare your Rule-of-2/4 equity to pot odds; consider
  semi-bluff raising (fold equity + your outs) instead of just calling.
- **Set on a wet board:** bet/raise — protect against draws; don't slow-play into 4 flush cards.
- **Facing an all-in on the river:** pure pot-odds + how often they're bluffing vs value. If your hand
  beats only bluffs, you need them bluffing ≥ pot-odds % to call.

## Bankroll & tilt (home-game sanity)

- Only play with money you're fine losing for the night — it's a social game, variance is huge short-term.
- **Don't chase losses.** Re-buying to "get even" is the fastest way to a bad night. דילר tracks the
  damage honestly so everyone settles fair.
- Skill shows over many sessions, not one. A bad beat ≠ a bad decision.

## Glossary (answer "מה זה X")

- **Equity** — your % chance to win the pot at showdown right now.
- **Range** — the set of hands a player could have in a spot (think in ranges, not single hands).
- **GTO** — game-theory-optimal, an unexploitable baseline strategy; vs weak players, *exploit* instead.
- **ICM** — tournament chip→$ model; chips aren't linear in payouts, so play tighter near pay jumps.
- **Outs** — cards that improve you to the likely best hand.
- **Pot odds / implied odds** — see the math section above.
- **Position** — where you act relative to others; "in position" (IP) = act last = advantage.

> Use real numbers when you can (compute outs → Rule of 2/4 → compare to pot odds). When the user
> gives a concrete spot (hand + board + action), walk the decision: equity vs pot odds, plus reads.
