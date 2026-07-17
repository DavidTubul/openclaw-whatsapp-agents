import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANNOUNCE_CONTRACT, withContract, feedEchoMessage } from './cron-contract.mjs';

test('contract names the core failure modes', () => {
  assert.match(ANNOUNCE_CONTRACT, /announce/);
  assert.match(ANNOUNCE_CONTRACT, /message send/);
  assert.match(ANNOUNCE_CONTRACT, /נשלח/);
  assert.match(ANNOUNCE_CONTRACT, /delivered|logged/);
});

test('withContract appends the contract to the body', () => {
  const out = withContract('  הרץ את הכלי וכתוב בדיחה  ');
  assert.ok(out.startsWith('הרץ את הכלי וכתוב בדיחה'));
  assert.ok(out.includes(ANNOUNCE_CONTRACT));
});

test('feedEchoMessage embeds the command and the contract', () => {
  const cmd = 'node /x/shared/tools/cron-feed.mjs --agent poker --feed lesson print';
  const out = feedEchoMessage(cmd);
  assert.ok(out.includes(cmd));
  assert.match(out, /stdout/);
  assert.ok(out.includes(ANNOUNCE_CONTRACT));
});
