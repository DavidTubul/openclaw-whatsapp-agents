// shared/lib/agent-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAgent,
  getAgentByGroup,
  listAgents,
  getGroups,
  getGroupByName,
  resolveGroupRef,
  isPlaceholderJid,
  _loadRegistry,
} from './agent-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = path.resolve(__dirname, '..', 'registry.example.json');

// Value assertions run against the committed EXAMPLE registry (placeholders only,
// no real PII) via the _loadRegistry seam, so they are identical on the live host
// and on a fresh clone. The public-API tests below stay value-independent.
const EX = _loadRegistry(EXAMPLE_PATH);
const exById = EX.byId;
const exByGroup = EX.byGroup;

test('example registry: 4 LIVE answering bots + archived pitzi + the listener record', () => {
  // Every entry is still normalized (archived pitzi + listener) → byId indexes all 6.
  assert.equal(EX.records.length, 6);
  // LIVE answering = not the listener AND not archived. pitzi is retired (archived) 2026-07-17.
  const liveAnswering = EX.records.filter((a) => !a.listenerAgent && !a.archived).map((a) => a.agentId).sort();
  assert.deepEqual(liveAnswering, ['digit', 'main', 'poker', 'zorro']);
  const pitzi = exById.get('pitzi');
  assert.ok(pitzi, 'archived pitzi is still normalized (kept for revival)');
  assert.equal(pitzi.archived, true);
  assert.ok(exById.get('listener'));
});

test('isPlaceholderJid: placeholder / missing → true; a real jid → false', () => {
  // The example registry ships placeholder jids (the fresh-clone fallback) — the send guards in
  // boot-notify + zorro's remind-pending must treat these as "no group configured" and skip.
  assert.equal(isPlaceholderJid(exById.get('zorro').primaryGroupId), true); // '<ZORRO_GROUP_ID>@g.us'
  assert.equal(isPlaceholderJid('<JOBSCOUT_GROUP_ID>@g.us'), true);
  assert.equal(isPlaceholderJid(undefined), true);
  assert.equal(isPlaceholderJid(null), true);
  assert.equal(isPlaceholderJid(''), true);
  assert.equal(isPlaceholderJid('120363000000000000@g.us'), false); // a real resolved jid
});

test('normalize(main) resolves symbolic group refs + derives Scotty fields', () => {
  const a = exById.get('main');
  assert.ok(a);
  assert.equal(a.persona.name, 'סקוטי');
  assert.equal(a.identity.name, 'סקוטי');
  assert.equal(a.identity.emoji, '🤖');
  assert.deepEqual(a.identity.mentionPatterns, ['סקוטי']); // default = [name]
  assert.equal(a.primaryGroup, 'jobscout-main'); // symbolic preserved
  assert.equal(a.primaryGroupId, '<JOBSCOUT_GROUP_ID>@g.us'); // resolved to jid
  assert.deepEqual(a.groupIds, ['<JOBSCOUT_GROUP_ID>@g.us']);
  assert.equal(a.listenerAgent, false);
  assert.equal(a.keyPrefix, 'agent:main:');
  assert.equal(a.sessionStore, '~/.openclaw/agents/main/sessions');
  assert.equal(a.fromLabel.outbound, 'סקוטי');
  assert.equal(a.cronTargets.default, 'jobscout-main');
  assert.equal(a.roster.type, 'people');
  assert.ok(path.isAbsolute(a.workspaceDir));
  assert.ok(path.isAbsolute(a.dataDir));
  assert.ok(a.dataDir.endsWith(path.join('workspace-jobscout', 'data')));
  assert.ok(path.isAbsolute(a.roster.file));
  assert.ok(path.isAbsolute(a.configPath));
  assert.equal(a.sessionHygiene.recent_window, 60);
  assert.equal(a.sessionHygiene.max_transcript_bytes, 1000000);
});

test('byGroup index matches each LIVE bot primary group; archived pitzi is absent', () => {
  assert.equal(exByGroup.get('<POKER_GROUP_ID>@g.us').agentId, 'poker');
  assert.equal(exByGroup.get('<ZORRO_GROUP_ID>@g.us').agentId, 'zorro');
  // pitzi is archived → its group never enters the byGroup index (nothing routes to a retired bot).
  assert.equal(exByGroup.get('<PITZI_GROUP_ID>@g.us'), undefined);
});

test('digit carries its two answering groups + a listen group; both answering groups index to digit', () => {
  const a = exByGroup.get('<DIGIT_GROUP_ID>@g.us');
  assert.ok(a);
  assert.equal(a.agentId, 'digit');
  assert.equal(a.groupIds.length, 2);
  assert.equal(exByGroup.get('<DIGIT_GROUP_ID_2>@g.us').agentId, 'digit');
  assert.deepEqual(a.groupIds, ['<DIGIT_GROUP_ID>@g.us', '<DIGIT_GROUP_ID_2>@g.us']);
  // digit OWNS the listen group via listenGroups (resolved), but it is NOT among its answering groupIds.
  assert.deepEqual(a.listenGroups, ['digit-listen']);
  assert.deepEqual(a.listenGroupIds, ['<DIGIT_LISTEN_GROUP_ID>@g.us']);
  assert.ok(!a.groupIds.includes('<DIGIT_LISTEN_GROUP_ID>@g.us'));
  // digit's per-job cron target overrides default.
  assert.equal(a.cronTargets['digit-mail-check'], 'digit-dy');
  assert.equal(a.cronTargets.default, 'digit-main');
});

test('listenOnly group never resolves to an answering agent (getAgentByGroup === null)', () => {
  // The listen jid must be absent from the byGroup index entirely.
  assert.equal(exByGroup.get('<DIGIT_LISTEN_GROUP_ID>@g.us'), undefined);
  // And the listener agent itself has empty answering groups.
  const listener = exById.get('listener');
  assert.ok(listener);
  assert.equal(listener.listenerAgent, true);
  assert.deepEqual(listener.groupIds, []);
  // Its unmatchable mention pattern round-trips from the registry.
  assert.deepEqual(listener.identity.mentionPatterns, ['OPENCLAW_LISTENER_NEVER_MATCH_x7f3a9']);
  assert.equal(listener.identity.emoji, '👂');
});

test('byGroup returns undefined for unknown group', () => {
  assert.equal(exByGroup.get('000000000000000000@g.us'), undefined);
});

test('roster types: digit none, poker players file (absolute)', () => {
  assert.equal(exById.get('digit').roster.type, 'none');
  const poker = exById.get('poker');
  assert.equal(poker.roster.type, 'players');
  assert.ok(poker.roster.file.endsWith(path.join('workspace-poker', 'data', 'players.json')));
});

test('zorro roster is members with fallback, persona דאוס for poker', () => {
  const z = exById.get('zorro');
  assert.equal(z.roster.type, 'members');
  assert.ok(z.roster.file.endsWith(path.join('data', 'streaks', 'members.jsonl')));
  assert.ok(path.isAbsolute(z.roster.fallbackFile));
  assert.equal(exById.get('poker').persona.name, 'דאוס');
});

test('owner e164 propagates from top-level owner to every agent (no per-agent copy)', () => {
  assert.equal(exById.get('main').owner.e164, '<OWNER_E164>');
  assert.equal(exById.get('digit').owner.e164, '<OWNER_E164>');
  assert.equal(exById.get('listener').owner.e164, '<OWNER_E164>');
});

// ── group accessors ──

test('_loadRegistry exposes the normalized symbolic groups map', () => {
  const g = EX.groups;
  assert.equal(g['jobscout-main'].jid, '<JOBSCOUT_GROUP_ID>@g.us');
  assert.equal(g['jobscout-main'].requireMention, true);
  assert.equal(g['digit-listen'].listenOnly, true);
  assert.equal(g['digit-listen'].requireMention, false); // listenOnly is forced false
  assert.equal(g['digit-listen'].routeAgentId, 'listener');
  assert.ok(g['digit-listen'].systemPrompt);
});

// ── archived (retirement) support ──

test('EX index: archived pitzi is normalized-but-flagged and out of byGroup + liveGroupRefs', () => {
  const pitzi = exById.get('pitzi');
  assert.ok(pitzi);
  assert.equal(pitzi.archived, true);
  // Its group carries the archived flag, is referenced ONLY by the archived agent, and never indexes.
  assert.equal(EX.groups['pitzi-demo'].archived, true);
  assert.equal(EX.liveGroupRefs.has('pitzi-demo'), false);
  assert.equal(exByGroup.get(EX.groups['pitzi-demo'].jid), undefined);
  // A LIVE group is still referenced (sanity: the set is populated for non-archived agents).
  assert.equal(EX.liveGroupRefs.has('poker-main'), true);
});

test('getAgent hides an archived agent by default; {includeArchived:true} is the escape hatch', () => {
  assert.equal(getAgent('pitzi'), null);
  const revived = getAgent('pitzi', { includeArchived: true });
  assert.ok(revived);
  assert.equal(revived.agentId, 'pitzi');
  assert.equal(revived.archived, true);
});

test('getAgentByGroup never resolves an archived group; resolveGroupRef still does (revival)', () => {
  const pitziJid = getGroupByName('pitzi-demo') && getGroupByName('pitzi-demo').jid;
  // getGroupByName resolves regardless of archived (needed to compute the jid for revival)…
  assert.ok(pitziJid);
  assert.equal(resolveGroupRef('pitzi-demo'), pitziJid);
  // …but the archived jid resolves to NO answering agent.
  assert.equal(getAgentByGroup(pitziJid), null);
});

test('getGroups omits an archived+unreferenced group by default; includeArchived returns it', () => {
  const live = getGroups();
  assert.ok(!('pitzi-demo' in live), 'archived pitzi-demo omitted from getGroups() by default');
  const withArchived = getGroups({ includeArchived: true });
  assert.ok('pitzi-demo' in withArchived, 'includeArchived:true returns pitzi-demo');
  assert.equal(withArchived['pitzi-demo'].archived, true);
});

// ── Public API smoke tests: value-independent (work against whichever registry
//    is live — real registry.json on the host, example on a fresh clone). ──

test('listAgents: 4 live answering bots by default; +listener via includeListenOnly; archived only via includeArchived', () => {
  const all = listAgents();
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((a) => a.agentId).sort(), ['digit', 'main', 'poker', 'zorro']);
  assert.ok(!all.some((a) => a.agentId === 'pitzi'), 'archived pitzi excluded by default');
  assert.ok(!all.some((a) => a.agentId === 'listener'));

  // includeListenOnly adds the listener but NOT the archived agent — the flags are orthogonal.
  const withListener = listAgents({ includeListenOnly: true });
  assert.equal(withListener.length, 5);
  assert.ok(withListener.some((a) => a.agentId === 'listener'));
  assert.ok(!withListener.some((a) => a.agentId === 'pitzi'), 'archived pitzi still excluded');

  // includeArchived is required to surface the retired agent (used by registry-sync).
  const withArchived = listAgents({ includeListenOnly: true, includeArchived: true });
  assert.equal(withArchived.length, 6);
  assert.ok(withArchived.some((a) => a.agentId === 'pitzi'));
});

test('getAgent resolves derived fields and returns null for unknown id', () => {
  const a = getAgent('main');
  assert.ok(a);
  assert.equal(a.persona.name, 'סקוטי');
  assert.equal(a.keyPrefix, 'agent:main:');
  assert.equal(a.sessionStore, '~/.openclaw/agents/main/sessions');
  assert.ok(path.isAbsolute(a.workspaceDir));
  assert.equal(getAgent('nope'), null);
});

test('getAgentByGroup resolves each answering bot via its own primary group', () => {
  // Round-trip through the live index without hardcoding any group id.
  for (const rec of listAgents()) {
    assert.equal(getAgentByGroup(rec.primaryGroupId).agentId, rec.agentId);
  }
  assert.equal(getAgentByGroup('000000000000000000@g.us'), null);
});

test('getGroups / getGroupByName / resolveGroupRef accessors', () => {
  const groups = getGroups();
  // every answering agent's primary symbolic group is present and round-trips to its jid.
  for (const rec of listAgents()) {
    assert.ok(groups[rec.primaryGroup], `groups map missing ${rec.primaryGroup}`);
    assert.equal(resolveGroupRef(rec.primaryGroup), rec.primaryGroupId);
    assert.equal(getGroupByName(rec.primaryGroup).jid, rec.primaryGroupId);
  }
  // pass-through: a jid resolves to itself; unknown name -> null.
  const someJid = listAgents()[0].primaryGroupId;
  assert.equal(resolveGroupRef(someJid), someJid);
  assert.equal(resolveGroupRef('no-such-group'), null);
  assert.equal(getGroupByName('no-such-group'), null);
});
