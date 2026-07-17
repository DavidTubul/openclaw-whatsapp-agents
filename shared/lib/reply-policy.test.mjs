// shared/lib/reply-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyText, bootstrapNote, BOOTSTRAP_FILES } from './reply-policy.mjs';

const DAVID = { owner: { e164: '972500000000', label: 'דוד' } };

test('buildPolicyText returns non-empty markdown', () => {
  const t = buildPolicyText(DAVID);
  assert.equal(typeof t, 'string');
  assert.ok(t.trim().length > 100, 'should be a substantial block');
});

test('works with no/partial agentCfg (generic, owner defaults to דוד)', () => {
  for (const cfg of [undefined, {}, { owner: {} }]) {
    const t = buildPolicyText(cfg);
    assert.ok(t.includes('דוד'), 'defaults owner label to דוד');
  }
});

test('rule (a): bundled messages — answer the [Current message] and EACH in order', () => {
  const t = buildPolicyText(DAVID);
  assert.ok(t.includes('[Current message - respond to this]'), 'names the current-message marker');
  assert.match(t, /כל אחת|לכולן/, 'says answer each / all of them');
  assert.match(t, /לפי הסדר/, 'in order');
  assert.match(t, /אל תענה רק להודעה האחרונה/, 'never only the last');
});

test('rule (b): real @mention by phone — sender AND anyone addressed; no self-tag for owner', () => {
  const t = buildPolicyText(DAVID);
  assert.ok(t.includes('[from:'), 'references the [from: ...] marker');
  assert.ok(t.includes('+E164'), 'references the E164 the gateway provides');
  // the verified mechanism: a standalone @<digits> token becomes a real mention (e.g. @972501234567)
  assert.match(t, /@972501234567/, 'gives a concrete @<digits> mention example');
  assert.match(t, /mention/, 'explains it becomes a real WhatsApp mention');
  // broadened: tag not only the sender but anyone you address/name (not just reply to the sender)
  assert.match(t, /פונה אליו|נוקב בשמו/, 'instructs tagging anyone addressed, not only the sender');
  // quoting alone does NOT notify — you must actually @tag
  assert.match(t, /ציטוט-reply לבדו לא מתריע|לא מתריע/, 'warns a quote alone does not notify');
  // owner exception present
  assert.match(t, /אינו/, 'conditions the @tag on the sender NOT being the owner');
  assert.match(t, /אל\*?\*? ?תתייג את עצמך|אל תתייג/, 'owner is NOT self-tagged');
});

test('rule (b): owner label is interpolated from agentCfg', () => {
  const t = buildPolicyText({ owner: { label: 'דוד' } });
  assert.ok(t.includes('דוד'), 'uses the configured owner label');
});

test('rule (c): auto-sent/auto-quoted, do NOT call message send for normal reply', () => {
  const t = buildPolicyText(DAVID);
  assert.match(t, /replyToMode/, 'mentions replyToMode');
  assert.match(t, /אל תקרא ל-`message send`/, 'forbids message send for a normal reply');
  assert.match(t, /ישכפל|לשכפל|שכפל/, 'explains it would duplicate');
});

test('persona-neutral: no hard-coded persona names leak in', () => {
  const t = buildPolicyText(DAVID);
  for (const name of ['סקוטי', 'דיגיט', 'דאוס', 'פיצי', 'זורו']) {
    assert.ok(!t.includes(name), `policy must not hard-code persona ${name}`);
  }
});

test('BOOTSTRAP_FILES is the verified 6-file injected set', () => {
  assert.deepEqual(
    [...BOOTSTRAP_FILES].sort(),
    ['AGENTS.md', 'HEARTBEAT.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md'],
  );
});

test('bootstrapNote names all six files and the always-on constraint', () => {
  const n = bootstrapNote();
  assert.ok(typeof n === 'string' && n.length > 50);
  for (const f of BOOTSTRAP_FILES) assert.ok(n.includes(f), `mentions ${f}`);
  assert.match(n, /נטען אוטומטית/, 'explains what is auto-injected');
});
