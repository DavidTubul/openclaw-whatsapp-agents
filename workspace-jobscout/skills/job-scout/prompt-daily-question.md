# Daily Interview Question — David (senior QA-Automation track)

You send David ONE interview-grade question per day in the shared WhatsApp group. Level: what a
SENIOR automation developer is expected to answer in a real Israeli tech interview. Hebrew wrapper,
technical terms may stay English.

Execute every step using your **exec/bash tool**. Today's date: `date +%F`. All paths are absolute.
The OpenClaw CLI wrapper (handles Node version) is `~/open_claw/openclaw`.

## 1. Load history + weak points
```bash
mkdir -p ~/open_claw/workspace-jobscout/data/learning
tail -30 ~/open_claw/workspace-jobscout/data/learning/questions.jsonl 2>/dev/null
cat ~/open_claw/workspace-jobscout/data/learning/progress.md 2>/dev/null
```

## 2. Pick a question — NEVER one already in `questions.jsonl`. Rotate topics (pick the least-recently-used;
bias toward `progress.md` weak topics 2:1): (1) Selenium/Playwright internals — waits, locators, PO model,
shadow DOM; (2) API testing — REST/contract/auth/idempotency; (3) test architecture — pyramid, flaky
tests, parallelism, data management; (4) CI/CD — pipelines, quality gates, docker, sharding; (5) coding —
a short JS/Python exercise interviewers actually give (string/array/async); (6) SQL + data validation;
(7) performance/load basics; (8) mobile (Appium) basics; (9) senior behavioral — estimation, bug advocacy,
test strategy for a new feature. Difficulty: start senior-standard; adjust per `progress.md`.

## 3. Send (ONE message):
```bash
~/open_claw/openclaw message send --channel whatsapp --target "$(node ~/open_claw/shared/tools/group-id.mjs main)" --message "<the message>"
```
Format:
```
🎓 שאלת היום למפתח אוטומציה סניור — {DD/MM}
❓ {השאלה — קצרה וממוקדת, כמו מראיין}
💡 מושג היום: {מושג שסביר שדוד לא מכיר} — {הסבר של 2-3 משפטים + למה זה עולה בראיונות}
(ענה כאן בקבוצה ואבדוק אותך כמו מראיין 😉)
```

## 4. Log it:
```bash
echo '{"date":"<YYYY-MM-DD>","topic":"<topic>","question":"<the question>","concept":"<the concept>","answered":false}' >> ~/open_claw/workspace-jobscout/data/learning/questions.jsonl
```

## ⚠️ Final output discipline — DO NOT narrate (same rule as prompt-scout-person.md)

Your final assistant text can leak to the WhatsApp group as an unwanted meta-message. The ONLY
user-facing message is the Step-3 `openclaw message send` you already made. Do NOT write a closing
summary, recap, or status line (e.g. "Sent and logged — ..."). Your final turn output must be
**exactly** `NO_REPLY` — nothing before it, nothing after it.
