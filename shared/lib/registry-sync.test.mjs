// shared/lib/registry-sync.test.mjs — pure diff logic, fixture-driven (no live gateway/registry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffGroups, diffBindings, diffAgents, diffCron, computeSync,
} from './registry-sync.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

function baseModel() {
  return {
    mainAgentId: 'main',
    groups: [
      { name: 'main-g', jid: 'J1@g.us', requireMention: true, listenOnly: false },
      { name: 'digit-g', jid: 'J2@g.us', requireMention: true, listenOnly: false },
      { name: 'digit-dy', jid: 'J3@g.us', requireMention: true, listenOnly: false },
      { name: 'listen-g', jid: 'JL@g.us', requireMention: false, listenOnly: true, routeAgentId: 'listener', systemPrompt: 'SP' },
    ],
    agents: [
      { agentId: 'main', identityName: 'M', identityEmoji: '🤖', mentionPatterns: ['M'],
        workspaceAbs: '/ws/main', groupJids: ['J1@g.us'], answering: true, cronTargetJids: {}, cronDefaultJid: 'J1@g.us' },
      { agentId: 'digit', identityName: 'D', identityEmoji: '🏠', mentionPatterns: ['D'],
        workspaceAbs: '/ws/digit', groupJids: ['J2@g.us', 'J3@g.us'], answering: true,
        cronTargetJids: { 'digit-mail-check': 'J3@g.us' }, cronDefaultJid: 'J2@g.us' },
      { agentId: 'listener', identityName: 'L', identityEmoji: '👂', mentionPatterns: ['NEVER'],
        workspaceAbs: '/ws/listener', groupJids: [], answering: false, cronTargetJids: {}, cronDefaultJid: undefined },
    ],
  };
}

function baseConfig() {
  return {
    agents: {
      defaults: { workspace: '/ws/main' },
      list: [
        { id: 'main', identity: { name: 'M', emoji: '🤖' }, groupChat: { mentionPatterns: ['M'] } },
        { id: 'digit', workspace: '/ws/digit', identity: { name: 'D', emoji: '🏠' }, groupChat: { mentionPatterns: ['D'] } },
        { id: 'listener', workspace: '/ws/listener', identity: { name: 'L', emoji: '👂' }, groupChat: { mentionPatterns: ['NEVER'] } },
      ],
    },
    bindings: [
      { type: 'route', agentId: 'digit', match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: 'J2@g.us' } } },
      { type: 'route', agentId: 'listener', match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: 'JL@g.us' } } },
      { type: 'route', agentId: 'main', match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: 'J1@g.us' } } },
      { type: 'route', agentId: 'digit', match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: 'J3@g.us' } } },
      { type: 'route', agentId: 'main', match: { channel: 'whatsapp' } },
    ],
    channels: {
      whatsapp: {
        accounts: {
          default: {
            groups: {
              'J1@g.us': { requireMention: true },
              'JL@g.us': { requireMention: false, systemPrompt: 'SP' },
              'J2@g.us': { requireMention: true },
              'J3@g.us': { requireMention: true },
            },
          },
        },
      },
    },
  };
}

function baseCron() {
  return [
    { id: 'c1', name: 'main-daily', agentId: 'main', delivery: { to: 'J1@g.us' } },
    { id: 'c2', name: 'digit-mail-check', agentId: 'digit', delivery: { to: 'J3@g.us' } },
    { id: 'c3', name: 'digit-other', agentId: 'digit', delivery: { to: 'J2@g.us' } },
    { id: 'c4', name: 'foreign', agentId: 'ghost', delivery: { to: 'X@g.us' } },
  ];
}

// ── the golden path: live-mirror registry is a no-op ──
test('in-sync fixtures produce ZERO drift and no config change', () => {
  const r = computeSync({ model: baseModel(), config: baseConfig(), cronJobs: baseCron() });
  assert.deepEqual(r.drifts, []);
  assert.deepEqual(r.cronEdits, []);
  assert.equal(r.changedConfig, false);
  // apply would be a true no-op: patched deep-equals input.
  assert.deepEqual(r.patchedConfig, baseConfig());
});

// ── groups view ──
test('groups: requireMention mismatch is flagged + patched', () => {
  const cfg = baseConfig();
  cfg.channels.whatsapp.accounts.default.groups['J1@g.us'].requireMention = false;
  const { drifts, patch } = diffGroups(baseModel(), cfg);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].kind, 'requireMention');
  assert.equal(patch()['J1@g.us'].requireMention, true);
});

test('groups: extra config group + missing registry group are both flagged', () => {
  const cfg = baseConfig();
  cfg.channels.whatsapp.accounts.default.groups['J9@g.us'] = { requireMention: true }; // extra
  delete cfg.channels.whatsapp.accounts.default.groups['J2@g.us']; // missing
  const { drifts, patch } = diffGroups(baseModel(), cfg);
  const kinds = drifts.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['extra', 'missing']);
  const patched = patch();
  assert.ok(patched['J2@g.us'], 'missing group restored');
  assert.ok(!patched['J9@g.us'], 'extra group dropped');
});

test('groups: listen-only systemPrompt drift + non-listen must not carry a systemPrompt', () => {
  const cfg = baseConfig();
  cfg.channels.whatsapp.accounts.default.groups['JL@g.us'].systemPrompt = 'changed';
  cfg.channels.whatsapp.accounts.default.groups['J1@g.us'].systemPrompt = 'oops';
  const { drifts, patch } = diffGroups(baseModel(), cfg);
  assert.ok(drifts.some((d) => d.kind === 'systemPrompt'));
  assert.ok(drifts.some((d) => d.kind === 'unexpected-systemPrompt'));
  const patched = patch();
  assert.equal(patched['JL@g.us'].systemPrompt, 'SP');
  assert.equal(patched['J1@g.us'].systemPrompt, undefined);
});

// ── bindings view ──
test('bindings: wrong agent on a route is flagged + patched', () => {
  const cfg = baseConfig();
  cfg.bindings[0].agentId = 'poker'; // J2 should be digit
  const { drifts, patch } = diffBindings(baseModel(), cfg);
  assert.ok(drifts.some((d) => d.kind === 'wrong-agent' && d.jid === 'J2@g.us'));
  const patched = patch();
  const j2 = patched.find((b) => b.match && b.match.peer && b.match.peer.id === 'J2@g.us');
  assert.equal(j2.agentId, 'digit');
  assert.deepEqual(patched[patched.length - 1].match, { channel: 'whatsapp' }); // catch-all last
});

test('bindings: catch-all not last is flagged, and patch moves it last', () => {
  const cfg = baseConfig();
  const ca = cfg.bindings.pop();
  cfg.bindings.unshift(ca); // catch-all first now
  const { drifts, patch } = diffBindings(baseModel(), cfg);
  assert.ok(drifts.some((d) => d.kind === 'catch-all-not-last'));
  const patched = patch();
  assert.equal(patched[patched.length - 1].match.channel, 'whatsapp');
  assert.ok(!patched[patched.length - 1].match.peer);
});

test('bindings: missing route is flagged + appended before catch-all', () => {
  const cfg = baseConfig();
  cfg.bindings = cfg.bindings.filter((b) => !(b.match && b.match.peer && b.match.peer.id === 'J3@g.us'));
  const { drifts, patch } = diffBindings(baseModel(), cfg);
  assert.ok(drifts.some((d) => d.kind === 'missing' && d.jid === 'J3@g.us'));
  const patched = patch();
  assert.ok(patched.some((b) => b.match && b.match.peer && b.match.peer.id === 'J3@g.us'));
  assert.equal(patched[patched.length - 1].match.channel, 'whatsapp');
});

test('bindings: non-whatsapp / non-group bindings are preserved untouched', () => {
  const cfg = baseConfig();
  const custom = { type: 'route', agentId: 'x', match: { channel: 'telegram' } };
  cfg.bindings.unshift(custom);
  const { drifts, patch } = diffBindings(baseModel(), cfg);
  assert.deepEqual(drifts, []);
  const patched = patch();
  assert.deepEqual(patched[0], custom);
});

// ── agents view ──
test('agents: identity + mentionPatterns drift flagged + patched; main keeps inherited workspace', () => {
  const cfg = baseConfig();
  cfg.agents.list[0].identity.emoji = '❌';
  cfg.agents.list[1].groupChat.mentionPatterns = ['WRONG'];
  const { drifts, patch } = diffAgents(baseModel(), cfg);
  assert.ok(drifts.some((d) => d.kind === 'identity.emoji' && d.agentId === 'main'));
  assert.ok(drifts.some((d) => d.kind === 'mentionPatterns' && d.agentId === 'digit'));
  const list = patch(clone(cfg.agents.list));
  assert.equal(list[0].identity.emoji, '🤖');
  assert.deepEqual(list[1].groupChat.mentionPatterns, ['D']);
  assert.equal(list[0].workspace, undefined, 'main must NOT gain a redundant workspace key');
});

test('agents: present-in-config-not-registry and vice versa are flagged', () => {
  const cfg = baseConfig();
  cfg.agents.list.push({ id: 'stale', identity: { name: 'S', emoji: '💀' }, groupChat: { mentionPatterns: ['S'] } });
  const model = baseModel();
  model.agents.push({ agentId: 'ghostbot', identityName: 'G', identityEmoji: '👻', mentionPatterns: ['G'],
    workspaceAbs: '/ws/ghost', groupJids: ['J8@g.us'], answering: true, cronTargetJids: {}, cronDefaultJid: 'J8@g.us' });
  const { drifts } = diffAgents(model, cfg);
  assert.ok(drifts.some((d) => d.kind === 'in-config-not-registry' && d.agentId === 'stale'));
  assert.ok(drifts.some((d) => d.kind === 'missing-in-config' && d.agentId === 'ghostbot'));
});

test('agents: a NEW registry agent absent from config is CREATED by --apply; full re-check is clean', () => {
  const model = baseModel();
  model.groups.push({ name: 'newbot-g', jid: 'J8@g.us', requireMention: true, listenOnly: false });
  model.agents.push({ agentId: 'newbot', identityName: 'ניל', identityEmoji: '🆕',
    mentionPatterns: ['ניל', 'neel'], workspaceAbs: '/ws/newbot', groupJids: ['J8@g.us'],
    answering: true, cronTargetJids: {}, cronDefaultJid: 'J8@g.us' });
  const cfg = baseConfig(); // has NO trace of newbot (allowlist / binding / agents.list)

  const r = computeSync({ model, config: cfg, cronJobs: baseCron() });
  assert.ok(r.drifts.some((d) => d.view === 'agents' && d.kind === 'missing-in-config' && d.agentId === 'newbot'),
    'missing agent is flagged');
  assert.equal(r.changedConfig, true);

  const created = r.patchedConfig.agents.list.find((a) => a.id === 'newbot');
  assert.ok(created, 'agents.list row created for the new agent');
  assert.equal(created.identity.name, 'ניל');
  assert.equal(created.identity.emoji, '🆕');
  assert.deepEqual(created.groupChat.mentionPatterns, ['ניל', 'neel']);
  assert.equal(created.workspace, '/ws/newbot');

  // idempotency: re-check against the patched config reports ZERO drift (create, group + binding all done).
  const after = computeSync({ model, config: r.patchedConfig, cronJobs: baseCron() });
  assert.deepEqual(after.drifts, [], JSON.stringify(after.drifts));
  assert.equal(after.changedConfig, false);
});

test('agents: wrong effective workspace flagged + patched (adds workspace key)', () => {
  const cfg = baseConfig();
  cfg.agents.list[1].workspace = '/ws/WRONG';
  const { drifts, patch } = diffAgents(baseModel(), cfg);
  assert.ok(drifts.some((d) => d.kind === 'workspace' && d.agentId === 'digit'));
  const list = patch(clone(cfg.agents.list));
  assert.equal(list[1].workspace, '/ws/digit');
});

// ── cron view ──
test('cron: wrong-group (a real group of the agent, but not the expected one) flagged + edit; non-registry jobs ignored', () => {
  const cron = baseCron();
  // digit-mail-check expects J3 (digit-dy); point it at J2 — still one of digit's OWN groups -> wrong-group.
  cron[1].delivery.to = 'J2@g.us';
  const { drifts, edits } = diffCron(baseModel(), cron);
  assert.equal(drifts.length, 1); // the ghost-agent job (c4) is ignored
  assert.equal(drifts[0].kind, 'wrong-group');
  assert.deepEqual(edits, [{ id: 'c2', name: 'digit-mail-check', agentId: 'digit', to: 'J3@g.us' }]);
});

test('cron: foreign JID (not among agent groups) flagged as foreign-group', () => {
  const cron = baseCron();
  cron[1].delivery.to = 'ZZZ@g.us'; // digit-mail-check should be J3
  const { drifts, edits } = diffCron(baseModel(), cron);
  assert.equal(drifts[0].kind, 'foreign-group');
  assert.equal(edits[0].to, 'J3@g.us');
});

test('cron: default target used when no per-job override', () => {
  const cron = [{ id: 'c9', name: 'digit-unknown-job', agentId: 'digit', delivery: { to: 'J2@g.us' } }];
  const { drifts } = diffCron(baseModel(), cron); // J2 == digit's cronDefaultJid
  assert.deepEqual(drifts, []);
});

test('computeSync aggregates all four views + reports changedConfig', () => {
  const cfg = baseConfig();
  cfg.channels.whatsapp.accounts.default.groups['J1@g.us'].requireMention = false;
  const r = computeSync({ model: baseModel(), config: cfg, cronJobs: baseCron() });
  assert.ok(r.drifts.length >= 1);
  assert.equal(r.changedConfig, true);
  assert.equal(r.patchedConfig.channels.whatsapp.accounts.default.groups['J1@g.us'].requireMention, true);
});

// ── archived (retirement) removal ──
// A retired bot: its agent + its group are flagged `archived:true` in the model (the CLI builds the
// model with {includeArchived:true}). Its openclaw.json wiring must be flagged `archived` drift and
// DROPPED by --apply — while a truly-foreign entry (unknown to the registry) stays flagged-only.
function withArchived() {
  const model = baseModel();
  model.groups.push({ name: 'ret-g', jid: 'JR@g.us', requireMention: true, listenOnly: false, archived: true });
  model.agents.push({ agentId: 'ret', identityName: 'R', identityEmoji: '🥜', mentionPatterns: ['R'],
    workspaceAbs: '/ws/ret', groupJids: ['JR@g.us'], answering: true, archived: true,
    cronTargetJids: {}, cronDefaultJid: 'JR@g.us' });
  const cfg = baseConfig();
  cfg.channels.whatsapp.accounts.default.groups['JR@g.us'] = { requireMention: true }; // leftover allowlist
  cfg.bindings.splice(cfg.bindings.length - 1, 0, // leftover route, inserted before the catch-all
    { type: 'route', agentId: 'ret', match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: 'JR@g.us' } } });
  cfg.agents.list.push({ id: 'ret', workspace: '/ws/ret', identity: { name: 'R', emoji: '🥜' }, groupChat: { mentionPatterns: ['R'] } });
  const cron = baseCron();
  cron.push({ id: 'cr', name: 'ret-daily', agentId: 'ret', delivery: { to: 'JR@g.us' } });
  return { model, cfg, cron };
}

test('archived: leftover allowlist entry -> kind "archived" + dropped by patch (live groups kept)', () => {
  const { model, cfg } = withArchived();
  const { drifts, patch } = diffGroups(model, cfg);
  assert.deepEqual(drifts.map((d) => d.kind), ['archived']);
  assert.equal(drifts[0].jid, 'JR@g.us');
  const patched = patch();
  assert.ok(!('JR@g.us' in patched), 'archived group removed from allowlist');
  assert.ok(patched['J1@g.us'] && patched['J2@g.us'], 'live groups preserved');
});

test('archived: leftover binding -> kind "archived" + dropped, catch-all stays last', () => {
  const { model, cfg } = withArchived();
  const { drifts, patch } = diffBindings(model, cfg);
  assert.ok(drifts.some((d) => d.kind === 'archived' && d.jid === 'JR@g.us'));
  const patched = patch();
  assert.ok(!patched.some((b) => b.match && b.match.peer && b.match.peer.id === 'JR@g.us'), 'archived route removed');
  assert.deepEqual(patched[patched.length - 1].match, { channel: 'whatsapp' });
  assert.ok(patched.some((b) => b.match && b.match.peer && b.match.peer.id === 'J2@g.us'), 'live digit route preserved');
});

test('archived: leftover agents.list row -> "archived" + removed; a foreign agent is flagged, NOT removed', () => {
  const { model, cfg } = withArchived();
  cfg.agents.list.push({ id: 'foreign', identity: { name: 'F', emoji: '👽' }, groupChat: { mentionPatterns: ['F'] } });
  const { drifts, patch } = diffAgents(model, cfg);
  assert.ok(drifts.some((d) => d.kind === 'archived' && d.agentId === 'ret'));
  assert.ok(drifts.some((d) => d.kind === 'in-config-not-registry' && d.agentId === 'foreign'));
  const list = patch(clone(cfg.agents.list));
  assert.ok(!list.some((a) => a.id === 'ret'), 'archived agent removed');
  assert.ok(list.some((a) => a.id === 'foreign'), 'foreign agent preserved (flagged only)');
  assert.ok(list.some((a) => a.id === 'main') && list.some((a) => a.id === 'digit'), 'live agents preserved');
});

test('archived: a cron owned by an archived agent is ignored (no drift, no edit)', () => {
  const { model, cron } = withArchived();
  const { drifts, edits } = diffCron(model, cron);
  assert.ok(!drifts.some((d) => d.agentId === 'ret'));
  assert.ok(!edits.some((e) => e.agentId === 'ret'));
});

test('archived: computeSync removes ALL leftover wiring in one pass (exactly 3 archived drifts)', () => {
  const { model, cfg, cron } = withArchived();
  const r = computeSync({ model, config: cfg, cronJobs: cron });
  assert.equal(r.changedConfig, true);
  const p = r.patchedConfig;
  assert.ok(!('JR@g.us' in p.channels.whatsapp.accounts.default.groups));
  assert.ok(!p.bindings.some((b) => b.match && b.match.peer && b.match.peer.id === 'JR@g.us'));
  assert.ok(!p.agents.list.some((a) => a.id === 'ret'));
  assert.deepEqual(p.bindings[p.bindings.length - 1].match, { channel: 'whatsapp' });
  assert.equal(r.drifts.length, 3, JSON.stringify(r.drifts.map((d) => ({ v: d.view, k: d.kind }))));
  assert.ok(r.drifts.every((d) => d.kind === 'archived'), 'every drift is an archived-leftover');
});
