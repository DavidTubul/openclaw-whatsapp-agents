import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContent, pickNext } from "./morning.mjs";

const MD = `# content.md

## עובדות
- \`fact-a\` — עובדה ראשונה.
- \`fact-b\` — עובדה שנייה.
- \`fact-c\` — עובדה שלישית.

> רעיון לתמונה: לא פריט — אין backtick-id.
`;

test("parseContent extracts every id+text bullet, in order", () => {
  const items = parseContent(MD);
  assert.deepEqual(items.map((i) => i.id), ["fact-a", "fact-b", "fact-c"]);
  assert.equal(items[0].text, "עובדה ראשונה.");
  assert.equal(items[2].text, "עובדה שלישית.");
});

test("parseContent ignores prose lines without a backtick id", () => {
  assert.equal(parseContent("just text\n> a quote\n").length, 0);
});

test("pickNext: empty sent log → first item, not logged yet", () => {
  const items = parseContent(MD);
  const p = pickNext(items, [], "2026-06-27");
  assert.equal(p.id, "fact-a");
  assert.equal(p.alreadyLogged, false);
});

test("pickNext: skips already-sent ids, picks first fresh", () => {
  const items = parseContent(MD);
  const sent = [{ date: "2026-06-25", id: "fact-a" }, { date: "2026-06-26", id: "fact-b" }];
  const p = pickNext(items, sent, "2026-06-27");
  assert.equal(p.id, "fact-c");
  assert.equal(p.alreadyLogged, false);
});

test("pickNext: idempotent — today already logged returns same item, alreadyLogged", () => {
  const items = parseContent(MD);
  const sent = [{ date: "2026-06-27", id: "fact-b" }];
  const p = pickNext(items, sent, "2026-06-27");
  assert.equal(p.id, "fact-b");
  assert.equal(p.alreadyLogged, true);
  assert.equal(p.text, "עובדה שנייה.");
});

test("pickNext: all sent → recycles the one sent longest ago", () => {
  const items = parseContent(MD);
  const sent = [
    { date: "2026-06-20", id: "fact-b" }, // oldest
    { date: "2026-06-24", id: "fact-a" },
    { date: "2026-06-25", id: "fact-c" },
  ];
  const p = pickNext(items, sent, "2026-06-27");
  assert.equal(p.id, "fact-b");
  assert.equal(p.alreadyLogged, false);
});

test("pickNext: no items → null", () => {
  assert.equal(pickNext([], [], "2026-06-27"), null);
});
