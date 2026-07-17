// Pure logic for Dor's INFINITE, non-repeating daily lesson progression (no I/O — unit-tested).
//
// Walks an ordered syllabus, counts the lesson number up forever, and never repeats: every
// topic already taught lives in state.covered (seeded with the hands Dor already learned), and
// the tool hands that list to the agent as "do NOT repeat". When the syllabus is exhausted it
// emits endless distinct "advanced scenario" lessons so it literally never stops or loops.
//
// NOT migrated to shared/lib/cron-feed.mjs (the 2026-07-17 rotate/daily convergence): this is a
// genuinely different model. `rotate` cycles a fixed list; `daily` recycles least-recently-sent.
// `nextLesson` NEVER cycles or recycles — it monotonically counts up (state.count), advances a
// syllabus cursor (syllabus_index) past the end into synthesized "advanced" lessons, and carries a
// growing `covered[]` anti-repeat list. None of that fits the two shared strategies, so it stays here.

/**
 * @param {Array<{key:string,title:string,brief:string}>} syllabus
 * @param {{count?:number, syllabus_index?:number, covered?:string[]}} state
 * @returns {{lessonNumber:number, topic:{key,title,brief}, advanced:boolean, covered:string[], nextState:object}}
 */
export function nextLesson(syllabus, state = {}) {
  if (!Array.isArray(syllabus) || syllabus.length === 0) {
    throw new Error('syllabus is empty');
  }
  const total = syllabus.length;
  const idx = Number.isInteger(state.syllabus_index) && state.syllabus_index >= 0 ? state.syllabus_index : 0;
  const count = Number.isInteger(state.count) && state.count >= 0 ? state.count : 0;
  const covered = Array.isArray(state.covered) ? state.covered : [];
  const lessonNumber = count + 1;

  let topic;
  let advanced = false;
  if (idx < total) {
    topic = syllabus[idx];
  } else {
    advanced = true;
    const n = idx - total + 1; // 1,2,3… past the end of the syllabus
    topic = {
      key: `advanced-${n}`,
      title: `תרחיש משחק מתקדם #${n}`,
      brief: 'בחר ספוט אמיתי ממשחק ביתי שמשלב מושגים שכבר נלמדו, ונתח החלטה אחת לעומק. חייב להיות שונה מהשיעורים הקודמים — ראה את רשימת הנושאים שכבר נלמדו והימנע מחזרה.',
    };
  }

  const nextState = {
    count: lessonNumber,
    syllabus_index: idx + 1,
    last_topic: topic.title,
    covered: [...covered, topic.title],
  };
  return { lessonNumber, topic, advanced, covered, nextState };
}

/**
 * Safely append a topic to the syllabus (used when דאוס is asked to add a lesson topic).
 * Validates the shape and refuses duplicates by key, so the bot can't corrupt the file.
 * @param {Array<{key,title,brief}>} topics
 * @param {{key:string,title:string,brief:string}} t
 * @returns {Array} the new topics array
 */
export function addTopic(topics, t) {
  if (!Array.isArray(topics)) throw new Error('topics must be an array');
  const key = (t?.key || '').trim();
  const title = (t?.title || '').trim();
  const brief = (t?.brief || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`bad key (use kebab-case): "${key}"`);
  if (title.length < 3) throw new Error('title too short');
  if (brief.length < 5) throw new Error('brief too short');
  if (topics.some((x) => x.key === key)) throw new Error(`topic key already exists: "${key}"`);
  return [...topics, { key, title, brief }];
}
