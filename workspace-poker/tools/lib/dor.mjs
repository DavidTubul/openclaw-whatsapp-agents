// tools/lib/dor.mjs — helpers shared by the Dor coaching crons (dor-lesson / dor-quiz).

import { readFileSync } from 'node:fs';

// Dor's @-mention tag is a real phone number — keep it OUT of source. Read it from the
// gitignored .config/bot.json ("dorTag"), with a DOR_TAG env override.
export function loadDorTag() {
  try {
    return process.env.DOR_TAG
      || JSON.parse(readFileSync(new URL('../../.config/bot.json', import.meta.url), 'utf8')).dorTag
      || '';
  } catch { return ''; }
}
