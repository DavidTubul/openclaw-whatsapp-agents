import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentCfgFromRecord } from './agent-cfg.mjs';

const baseRec = (over = {}) => ({
  agentId: 'newbot',
  workspaceDir: '/w/newbot',
  dataDir: '/w/newbot/data',
  configPath: '/w/newbot/.config/bot.json',
  primaryGroupId: '555@g.us',
  groupIds: ['555@g.us'],
  persona: { name: 'נובו' },
  owner: { label: 'david' },
  roster: { type: 'none' },
  ...over,
});

test('unknown (6th) bot gets a WORKING derived config, not null — registry entry alone wires chat-log', () => {
  const cfg = agentCfgFromRecord(baseRec());
  assert.ok(cfg, 'must not be null for a registered but table-less agent');
  assert.equal(cfg.botName, 'נובו');
  assert.equal(cfg.labels.outboundFrom, 'נובו');
  assert.equal(cfg.labels.inboundFrom, 'david');
  assert.equal(cfg.labels.botSpeaker, 'נובו');
  assert.equal(cfg.e164DigitsOnly, false);
  assert.equal(cfg.classifyScout, false);
  assert.equal(cfg.media, false);
  assert.deepEqual(cfg.legacyBotNames, []);
  assert.equal(cfg.onRecord, undefined, 'no sheet mirror unless opted in');
  assert.equal(cfg.paths.dataDir, '/w/newbot/data/chat-log');
});

test('registry chatLog block overrides per key; unset keys keep defaults', () => {
  const cfg = agentCfgFromRecord(baseRec({
    chatLog: { labels: { inboundFrom: 'guest' }, e164DigitsOnly: true, sheetMirror: true, legacyBotNames: ['ישן'] },
  }));
  assert.equal(cfg.labels.inboundFrom, 'guest');
  assert.equal(cfg.labels.outboundFrom, 'נובו', 'unset label still derived');
  assert.equal(cfg.e164DigitsOnly, true);
  assert.deepEqual(cfg.legacyBotNames, ['ישן']);
  assert.equal(typeof cfg.onRecord, 'function', 'sheetMirror opt-in wires onRecord');
});

test('main keeps its exact chat-log labels via the registry chatLog.labels block (byte-identical)', () => {
  // The hardcoded LABELS table was removed 2026-07-17; main's quirks (lowercase "scotty" from-tag,
  // "Scotty" display, "אורח" inbound default) now live in its registry chatLog.labels block, applied
  // on top of the derived defaults. handler.test.mjs verifies this against the LIVE registry.
  const cfg = agentCfgFromRecord(baseRec({
    agentId: 'main', persona: { name: 'סקוטי' },
    fromLabel: { inbound: 'david', outbound: 'סקוטי' },
    chatLog: { labels: { outboundFrom: 'scotty', inboundSpeakerDefault: 'אורח', botSpeaker: 'Scotty' } },
  }));
  assert.equal(cfg.labels.outboundFrom, 'scotty', 'main keeps the lowercase legacy from-tag');
  assert.equal(cfg.labels.botSpeaker, 'Scotty');
  assert.equal(cfg.labels.inboundSpeakerDefault, 'אורח');
  assert.equal(cfg.classifyScout, true);
});

test('missing/id-less record → null', () => {
  assert.equal(agentCfgFromRecord(null), null);
  assert.equal(agentCfgFromRecord({}), null);
});
