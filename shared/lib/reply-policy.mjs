// shared/lib/reply-policy.mjs
//
// SINGLE source of truth for the group-reply policy text injected into every
// OpenClaw bot. This is the persona-neutral "how to behave when a group message
// arrives" block — extracted from the duplicated wording that lived inline in
// each workspace-*/AGENTS.md (jobscout / realestate / poker / pitzuchim /
// quitsmoke). Per-agent details (owner identity, persona name) come from the
// normalized agent record produced by agent-registry.mjs.
//
// Pure function, no side effects: takes an agent config object, returns a
// concise Hebrew markdown string. Callers splice the returned text into the
// bot's injected prompt (or write it to an injected bootstrap file).
//
// Exports:
//   buildPolicyText(agentCfg) -> string   (the reply-policy markdown block)
//   BOOTSTRAP_FILES                       (the recognized injected-file list)
//   bootstrapNote()                       -> string (constraint note about them)

/**
 * The ONLY workspace files OpenClaw injects into a bot's system prompt
 * (verified across digit/pitzi — see repo CLAUDE.md). Everything else
 * (SKILL.md, prompt-*.md, knowledge.md, RECENT_CHAT.md, CLAUDE.md) is read
 * on-demand and is NOT auto-injected. Any always-on rule must live in one of
 * these — which is exactly why the reply policy belongs here and gets folded
 * into AGENTS.md.
 */
export const BOOTSTRAP_FILES = Object.freeze([
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
]);

/**
 * The recognized-bootstrap-file constraint note. A short Hebrew reminder that
 * only the six BOOTSTRAP_FILES are auto-injected, so always-on rules (like this
 * reply policy) must live in them; the rest is read on demand.
 */
export function bootstrapNote() {
  return [
    '> ⚠️ **מה נטען אוטומטית לפרומפט:** רק ' +
      BOOTSTRAP_FILES.map((f) => '`' + f + '`').join(', ') +
      '. כל קובץ אחר (`SKILL.md`, `prompt-*.md`, `knowledge.md`, `RECENT_CHAT.md`, `CLAUDE.md`) ' +
      '**אינו** נטען אוטומטית — קוראים אותו על פי דרישה עם כלי ה-Read. לכן כל כלל ' +
      'שחייב **תמיד** לחול (כמו מדיניות התשובה הזו) חייב לשבת באחד מששת הקבצים האלה.',
  ].join('\n');
}

/** Owner display label, defaulting to David. */
function ownerLabel(agentCfg) {
  const o = agentCfg && agentCfg.owner;
  return (o && o.label) || 'דוד';
}

/**
 * buildPolicyText(agentCfg) -> string
 *
 * Returns the concise, persona-neutral Hebrew reply-policy markdown block.
 * It states three rules verbatim in intent (matching the original per-bot copy):
 *
 *  (a) You may receive several messages bundled into one input. The one tagged
 *      "[Current message - respond to this]" is what to answer NOW; if the input
 *      bundles several requests, answer EACH in order — never only the last.
 *  (b) OpenClaw appends "[from: Name (+E164)]" to each group message, telling you
 *      who sent it. ADDRESS that sender. If they are NOT the owner, OPEN your
 *      reply with "@<their +E164>" so the gateway turns it into a real WhatsApp
 *      mention. For the owner himself do NOT self-tag (just answer — it is
 *      auto-quoted onto his message anyway).
 *  (c) Your reply is auto-sent and auto-quoted onto the triggering message
 *      (replyToMode:"all"). Do NOT call `message send` for a normal reply — that
 *      duplicates it. `message send` is only for proactive/cron sends or media.
 *
 * @param {object} [agentCfg]  normalized agent record (agent-registry.mjs).
 *                             Only `owner.label` is used; everything else generic.
 * @returns {string} non-empty Hebrew markdown block.
 */
export function buildPolicyText(agentCfg) {
  const owner = ownerLabel(agentCfg);

  return [
    '## מדיניות תשובה בקבוצה (כלל תמידי)',
    '',
    '**(א) כמה הודעות ברצף — תענה לכולן, לפי הסדר, כולל מה שב-`[context]`.** הקלט מגיע בשני',
    'חלקים: **`[Current message - respond to this]`** (ההודעה שהעירה אותך) ולפניו לרוב',
    '**`[Chat messages since your last reply - for context]`**. ⚠️ **החלק של ה-context הוא לא רק',
    'רקע** — לעיתים קרובות יש בו הודעות שנשלחו אליך **ועוד לא ענית עליהן** (כי הן הגיעו בלי מילת',
    'ההפעלה, או בזמן שכבר היית עסוק בתשובה). **קרא את שני החלקים, אתר כל הודעה שמופנית אליך / שואלת',
    'אותך משהו / היא חלק מהשיחה איתך — וענה על כולן, מהישנה לחדשה, ביחד עם ה-`[Current message]`.**',
    'לעולם אל תתייחס ל-context כ"כבר טופל" ואל תענה רק להודעה האחרונה — להשמיט הודעה קודמת שפנתה',
    'אליך זה הדבר מספר 1 שגורם לך להיראות תקול. **כך גם עם בלוק `[Queued messages while agent was busy]`',
    '(הודעות שהצטברו בזמן שהיית עסוק, כל אחת מסומנת `Queued #n (from <שם>)`): ענה על כל אחת מהן',
    'שמופנית אליך, לפי הסדר, אחת-אחרי-השנייה — אל תדלג על אף אחת רק כי הגיעה חדשה יותר.** (אם הודעה',
    'היא סתם פטפוט בין אחרים שלא מכוון אליך — אפשר להתעלם ממנה; הכלל חל על מה שמופנה אליך.) נושא אחד →',
    'תשובה אחת שמכסה כל נקודה; בקשות נפרדות → התייחס לכל אחת בתורה.',
    '',
    '**(ב) למי אתה פונה — תייג אותו בפועל, לא רק בשם.** כדי שחבר בקבוצה יקבל התראה ויראה תיוג',
    'כחול, כתוב את **המספר שלו עם `@` כטוקן נפרד** (רווחים מסביב, ספרות בלבד) — למשל `@972501234567`.',
    'ה-gateway הופך את זה ל-mention אמיתי (עובד רק אם המספר שייך לחבר בקבוצה). ⚠️ **ציטוט-reply',
    'לבדו לא מתריע** — מי שתפנה אליו לא יֵדע שדיברת אליו אם לא תייגת בפועל. לכן:',
    '• **השולח:** ה-gateway מצרף לכל הודעה `[from: שם (+E164)]`. אם השולח אינו `' + owner + '`',
    '  (הבעלים) — פתח אליו ב-`@<המספר מתוך ה-[from:]>`.',
    '• **כל חבר שאתה פונה אליו או נוקב בשמו** — לא רק השולח, וגם כש`' + owner + '` ביקש ממך',
    '  "תפנה ל-X ול-Y": תייג **כל אחד מהם** ב-`@<המספר שלו>`. אל תכתוב רק את השם — שם בלי `@מספר`',
    '  לא מתייג ולא מתריע. את מספרי החברים אתה שולף מהנתונים שלך (`data/last-inbound.json`,',
    '  ה-roster / טבלת החברים) — לא ממציא; אם אין לך מספר, פנה בשם בלבד.',
    '• **את `' + owner + '` עצמו אל תתייג** — פשוט תענה (התשובה ממילא מצוטטת על ההודעה שלו).',
    '',
    '**(ג) התשובה נשלחת ומצוטטת אוטומטית.** טקסט התור שלך נשלח לקבוצה אוטומטית ומשורשר',
    'כ-quote-reply על ההודעה שהפעילה אותך (`replyToMode:"all"`). **אל תקרא ל-`message send`',
    'לתשובה רגילה — זה ישכפל את ההודעה.** `message send` הוא רק לשליחה יזומה (cron) או',
    'לשליחת מדיה.',
  ].join('\n');
}
