// shared/lib/cron-contract.mjs
//
// SINGLE source of truth for the "announce contract" — the persona-neutral rule
// every cron-driven OpenClaw bot must follow. With delivery.mode=announce the
// agent's FINAL turn text is posted to the group VERBATIM. Bots that don't know
// this turn their final message into a status report ("נשלח ✅" / "Lesson 6
// delivered and logged…") or call `message send` themselves — so the group gets a
// meta-line and the real content never arrives (docs/RUNBOOK.md §199–206, §175).
//
// This block is the cross-agent fix. It is spliced into every cron message:
//   - DYNAMIC crons (job-scout, weekly-review, zorro morning kick, poker teder roast):
//       withContract(body)        -> body + the contract
//   - FIXED-CONTENT crons (poker daily lesson + evening quiz): the content is produced
//     by shared/tools/cron-feed.mjs and the agent only echoes it verbatim:
//       feedEchoMessage(cmd)      -> "run <cmd>, your whole reply = its stdout" + contract
//
// Keeping the wording HERE (not copied inline per cron) means a future improvement to
// the rule fixes every bot at once — same principle as shared/lib/reply-policy.mjs.

/** The canonical announce-contract rule (Hebrew — all bots reply in Hebrew). */
export const ANNOUNCE_CONTRACT = [
  '⚠️ חוזה השליחה (announce): הטקסט הסופי שלך נשלח לקבוצה מילה-במילה. הפלט שלך = ההודעה עצמה בלבד.',
  'אסור בתכלית האיסור: דוח/סיכום/אישור כמו "נשלח", "delivered", "logged", "✅"; הקדמה ("הנה ההודעה…", "הפלט הסופי…"); קו מפריד "---"; כותרת מיותרת; אנגלית; הערות טכניות/דיאגנוסטיקה; או אזכור של WhatsApp/session/מצב-מערכת.',
  'אל תקרא ל-message send עבור הטקסט (זה שולח ליעד שגוי ומשאיר את הקבוצה עם הדוח). אל תכתוב לקבצים אלא אם הונחית מפורשות — הכלים כבר מטפלים בלוג ובמצב.',
].join('\n');

/**
 * Wrap a DYNAMIC cron body (the agent composes the message) with the contract.
 * @param {string} body  the task-specific instructions
 * @returns {string}
 */
export function withContract(body) {
  return `${String(body).trim()}\n\n${ANNOUNCE_CONTRACT}`;
}

/**
 * Build a FIXED-CONTENT cron message: run a deterministic tool and echo its stdout
 * verbatim. The content can't be anything but the tool's output — the strongest
 * form of the contract.
 * @param {string} cmd  exact shell command whose stdout IS the message
 * @returns {string}
 */
export function feedEchoMessage(cmd) {
  return [
    'הרץ דרך exec בדיוק את הפקודה הבאה וקרא את הפלט שלה (stdout):',
    '',
    String(cmd).trim(),
    '',
    'התשובה הסופית שלך חייבת להיות בדיוק ה-stdout של הפקודה — מילה במילה, תו בתו. אל תוסיף, תתרגם, תקצר או תעטוף שום דבר. אל תקרא לאף כלי אחר.',
    '',
    ANNOUNCE_CONTRACT,
  ].join('\n');
}
