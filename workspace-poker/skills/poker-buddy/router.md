# router.md — Hebrew intent → action

The message has already been stripped of the "דאוס" mention by the gateway. Match the intent,
run the command, reply in Hebrew. `<player>` is matched fuzzily by the tool (name/alias/nickname).
Money is in ₪. Commands default to the **current open session** unless an id is given.

## Bank / accounts

| Hebrew (examples) | Action |
|---|---|
| "תרשום ש<דני> קנה (עוד) 50" · "<דני> buy-in 50" · "<דני> נכנס ב-100" | `buyin "<דני>" 50` |
| "<דני> יצא עם 220" · "<דני> cash-out 220" · "תרשום ל<דני> 220 בסוף" | `cashout "<דני>" 220` |
| "כמה כל אחד עכשיו?" · "מה המצב בקופה?" · "תוצאות הערב" | `results` |
| "תסגור את הערב" · "סיימנו" · "תחשב מי חייב למי" | `close` → present its `settle` |
| "מי חייב למי?" · "settle" (ערב פתוח) | `settle` |
| "טעיתי, <דני> קנה 100 לא 50" | `reopen` if closed → re-enter correct `buyin`/`cashout` → `close` |

> A buy-in/cash-out auto-creates a session if none is open? **No** — if the tool says "no open session",
> ask if you should open one, or open it (`session new`) and proceed for an obviously-live game.

## Game organizing

| Hebrew | Action |
|---|---|
| "פותחים משחק [ביום X] [אצל דני] [ב-21:00]" · "נפתח ערב" | `session new [--date ..] [--location ..] [--time ..]` |
| "אני בא" · "<דני> בא" · "תרשום אותי" | `rsvp "<player>" in` |
| "אני לא בא" · "<דני> פורש" | `rsvp "<player>" out` |
| "אולי אבוא" | `rsvp "<player>" maybe` |
| "מי בא?" · "מי מאושר לערב?" · "פרטי הערב" | `session show` → list rsvp.in/out/maybe + location/time |

## Stats / leaderboard

| Hebrew | Action |
|---|---|
| "טבלה" · "מי מוביל?" · "מי המנצח הגדול?" · "leaderboard" | `leaderboard` |
| "כמה אני בפלוס/מינוס?" · "מה היתרה של <דני>?" | `balance "<player>"` |
| "כמה ערבים שיחקתי?" · "הניצחון הכי גדול שלי?" | `balance "<player>"` (has sessions/biggestWin/Loss) |
| "סטטיסטיקה כללית" | `leaderboard` (full table) |

## Poker coaching → strategy.md (NO tool)

| Hebrew | Action |
|---|---|
| "מה הסיכוי ש…?" · "כמה odds יש לי ל…?" · "pot odds" | read `strategy.md` → compute/explain |
| "איך לשחק <יד> מ<פוזיציה>?" · "כדאי לראיז/לקרוא/לפולד?" | `strategy.md` → recommend a line + reasoning |
| "מה זה <מושג>?" (GTO, range, equity, ICM…) | `strategy.md` → explain in Hebrew |

## Meta / fallback

| Hebrew | Action |
|---|---|
| "מי אתה?" · "דאוס תציג את עצמך" | greeting (see AGENTS.md) |
| "תשתוק / צא מהקבוצה / אתה מרמה" | light good-humored Hebrew; never go silent, never leave |
| anything unclear | ask a short clarifying question in Hebrew — never guess a money amount |

## Player resolution

- The tool matches `<player>` by id / name / alias / e164 / substring. If it returns
  "unknown player", `add-player "<name>"` first (the e164 from `data/last-inbound.json` if the
  speaker is registering themselves), then retry.
- **Never** record a buy-in/cash-out against the wrong person — if a name is ambiguous, ask.
