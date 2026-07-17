// shared/lib/registry-sync.mjs
//
// PURE diffing logic for registry-sync: given a normalized registry `model`, the parsed openclaw.json
// `config`, and the parsed `cronJobs` array, compute (a) the human/machine drift list, (b) a patched
// config that renders the four registry-derived views, and (c) the cron `--to` edits to apply.
// No I/O, no gateway calls, no imports of the live registry — every input is injected, so the whole
// thing is unit-testable with fixtures. The CLI (shared/tools/registry-sync.mjs) builds `model` from
// shared/lib/agent-registry.mjs, reads openclaw.json + `openclaw cron list --json`, and does the I/O.
//
// model shape (built by the CLI):
//   {
//     mainAgentId: "main",
//     groups: [ { name, jid, requireMention, listenOnly, archived?, routeAgentId?, systemPrompt? } ], // ALL groups
//     agents: [ {
//       agentId, identityName, identityEmoji, mentionPatterns:[...],
//       workspaceAbs,                 // expected absolute workspace path
//       groupJids: [...],             // resolved ANSWERING group jids
//       answering: bool,              // false for the shadow listener
//       archived?: bool,              // RETIRED — must be ABSENT from every openclaw.json view
//       cronTargetJids: { <jobName>: jid },   // resolved per-job cron overrides
//       cronDefaultJid,               // resolved default cron target (usually primary group)
//     } ],
//   }
//
// ARCHIVED handling: the CLI builds the model with {includeArchived:true} so archived agents/groups
// are PRESENT but flagged. The expected openclaw.json state for anything archived is ABSENCE — every
// view flags a leftover archived allowlist entry / binding / agents.list row as its own `archived`
// drift kind, and every patch DROPS it. A truly-foreign entry (in config, not in the registry at all)
// is still only FLAGGED, never auto-removed — so `--apply` removes archived leftovers generically
// without ever silently deleting an entry the registry doesn't know about.

function arrEq(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ── binding shape helpers ──
const isGroupRoute = (b) =>
  b && b.type === 'route' && b.match && b.match.channel === 'whatsapp' &&
  b.match.peer && b.match.peer.kind === 'group' && !!b.match.peer.id;

const isCatchAll = (mainId) => (b) =>
  b && b.type === 'route' && b.agentId === mainId &&
  b.match && b.match.channel === 'whatsapp' && !b.match.peer;

function makeGroupRoute(agentId, jid) {
  return {
    type: 'route',
    agentId,
    match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: jid } },
  };
}

function makeCatchAll(mainId) {
  return { type: 'route', agentId: mainId, match: { channel: 'whatsapp' } };
}

/** Expected owning agentId for a group jid: routeAgentId for listenOnly, else the LIVE agent whose
 *  answering groupJids include the jid. Archived agents never own a route. Returns null if unresolved. */
function owningAgentFor(model, group) {
  if (group.listenOnly) return group.routeAgentId || null;
  const a = model.agents.find((ag) => !ag.archived && ag.groupJids.includes(group.jid));
  return a ? a.agentId : null;
}

// ── View 1: channels.whatsapp.accounts.default.groups ──
export function diffGroups(model, config) {
  const drifts = [];
  const cfgGroups = config?.channels?.whatsapp?.accounts?.default?.groups || {};
  const base = 'channels.whatsapp.accounts.default.groups';

  // expected entry per jid (LIVE groups only — an archived group's expected state is ABSENCE).
  const expected = new Map(); // jid -> { name, requireMention, listenOnly, systemPrompt? }
  const archivedByJid = new Map(); // jid -> name, for archived groups (leftover-detection messages)
  for (const g of model.groups) {
    if (g.archived) { archivedByJid.set(g.jid, g.name); continue; }
    const e = { name: g.name, listenOnly: !!g.listenOnly, requireMention: g.listenOnly ? false : !!g.requireMention };
    if (g.listenOnly) e.systemPrompt = g.systemPrompt;
    expected.set(g.jid, e);
  }

  for (const [jid, e] of expected) {
    const p = `${base}["${jid}"]`;
    const actual = cfgGroups[jid];
    if (!actual) {
      drifts.push({ view: 'groups', kind: 'missing', path: p, jid, expected: e, actual: undefined,
        message: `group ${e.name} (${jid}) missing from config` });
      continue;
    }
    if (!!actual.requireMention !== e.requireMention) {
      drifts.push({ view: 'groups', kind: 'requireMention', path: `${p}.requireMention`, jid,
        expected: e.requireMention, actual: !!actual.requireMention,
        message: `${e.name}: requireMention expected ${e.requireMention}, got ${!!actual.requireMention}` });
    }
    if (e.listenOnly) {
      if (actual.systemPrompt !== e.systemPrompt) {
        drifts.push({ view: 'groups', kind: 'systemPrompt', path: `${p}.systemPrompt`, jid,
          expected: e.systemPrompt, actual: actual.systemPrompt,
          message: `${e.name}: listen-only systemPrompt differs from registry` });
      }
    } else if (actual.systemPrompt != null) {
      drifts.push({ view: 'groups', kind: 'unexpected-systemPrompt', path: `${p}.systemPrompt`, jid,
        expected: undefined, actual: actual.systemPrompt,
        message: `${e.name}: non-listen group has an unexpected systemPrompt in config` });
    }
  }
  for (const jid of Object.keys(cfgGroups)) {
    if (!expected.has(jid)) {
      if (archivedByJid.has(jid)) {
        drifts.push({ view: 'groups', kind: 'archived', path: `${base}["${jid}"]`, jid,
          expected: undefined, actual: cfgGroups[jid],
          message: `group ${archivedByJid.get(jid)} (${jid}) is archived in the registry but still present in the config allowlist` });
      } else {
        drifts.push({ view: 'groups', kind: 'extra', path: `${base}["${jid}"]`, jid,
          expected: undefined, actual: cfgGroups[jid],
          message: `config group ${jid} is not in the registry` });
      }
    }
  }

  // patch: preserve existing key order for kept jids, append registry-only jids; drop extras.
  const patch = () => {
    const out = {};
    const build = (jid) => {
      const e = expected.get(jid);
      const prev = cfgGroups[jid] || {};
      const merged = { ...prev, requireMention: e.requireMention };
      if (e.listenOnly) merged.systemPrompt = e.systemPrompt;
      else delete merged.systemPrompt;
      return merged;
    };
    for (const jid of Object.keys(cfgGroups)) if (expected.has(jid)) out[jid] = build(jid);
    for (const jid of expected.keys()) if (!(jid in out)) out[jid] = build(jid);
    return out;
  };

  return { drifts, patch };
}

// ── View 2: bindings ──
export function diffBindings(model, config) {
  const drifts = [];
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  const catchAllOf = isCatchAll(model.mainAgentId);

  // Every group's owning agent. Groups owned by the main (catch-all) agent do NOT need an explicit
  // route — the trailing catch-all already serves them (that is exactly how the jobscout group is
  // wired). So an EXPLICIT route is expected only for groups whose owner ≠ main; a redundant explicit
  // route to main on a main-owned group is allowed (not drift), never required.
  // Archived groups/agents must own NO route — their leftover binding is flagged (kind 'archived')
  // and dropped by the patch. Everything else keeps its existing semantics.
  const archivedGroupJids = new Set(model.groups.filter((g) => g.archived).map((g) => g.jid));
  const archivedAgentIds = new Set(model.agents.filter((a) => a.archived).map((a) => a.agentId));

  const jidToOwner = new Map(); // jid -> owning agentId
  for (const g of model.groups) {
    if (g.archived) continue; // archived group: no expected route
    const owner = owningAgentFor(model, g);
    if (owner) jidToOwner.set(g.jid, owner);
  }
  const expected = new Map(); // jid -> agentId (routes that MUST be explicit)
  for (const [jid, owner] of jidToOwner) {
    if (owner !== model.mainAgentId) expected.set(jid, owner);
  }
  const isRedundantMainRoute = (jid, agentId) =>
    jidToOwner.get(jid) === model.mainAgentId && agentId === model.mainAgentId;

  // actual group routes
  const actual = new Map(); // jid -> agentId (first seen)
  const dupes = [];
  for (const b of bindings) {
    if (!isGroupRoute(b)) continue;
    const jid = b.match.peer.id;
    if (actual.has(jid)) dupes.push(jid);
    else actual.set(jid, b.agentId);
  }

  for (const [jid, agentId] of expected) {
    if (!actual.has(jid)) {
      drifts.push({ view: 'bindings', kind: 'missing', path: `bindings[route ${jid}]`, jid,
        expected: agentId, actual: undefined, message: `missing route: ${jid} -> ${agentId}` });
    } else if (actual.get(jid) !== agentId) {
      drifts.push({ view: 'bindings', kind: 'wrong-agent', path: `bindings[route ${jid}]`, jid,
        expected: agentId, actual: actual.get(jid),
        message: `route ${jid} bound to ${actual.get(jid)}, expected ${agentId}` });
    }
  }
  for (const [jid, agentId] of actual) {
    if (!expected.has(jid) && !isRedundantMainRoute(jid, agentId)) {
      const isArch = archivedGroupJids.has(jid) || archivedAgentIds.has(agentId);
      drifts.push({ view: 'bindings', kind: isArch ? 'archived' : 'extra', path: `bindings[route ${jid}]`, jid,
        expected: undefined, actual: agentId,
        message: isArch
          ? `route ${jid} -> ${agentId} is archived in the registry but still present in config bindings`
          : `extra route ${jid} -> ${agentId} not in registry` });
    }
  }
  for (const jid of dupes) {
    drifts.push({ view: 'bindings', kind: 'duplicate', path: `bindings[route ${jid}]`, jid,
      expected: undefined, actual: undefined, message: `duplicate route binding for ${jid}` });
  }

  // catch-all must exist and be LAST
  const caIdx = bindings.findIndex(catchAllOf);
  if (caIdx === -1) {
    drifts.push({ view: 'bindings', kind: 'missing-catch-all', path: 'bindings[last]',
      expected: `route -> ${model.mainAgentId} (no peer)`, actual: undefined,
      message: `missing catch-all route to ${model.mainAgentId}` });
  } else if (caIdx !== bindings.length - 1) {
    drifts.push({ view: 'bindings', kind: 'catch-all-not-last', path: 'bindings[last]',
      expected: 'last', actual: `index ${caIdx}`, message: 'catch-all route must be the last binding' });
  }

  // patch: [ non-route/non-group + non-catch-all (original order), valid group routes (original
  //          order, reusing objects), missing routes appended, catch-all last ]
  const patch = () => {
    const other = bindings.filter((b) => !isGroupRoute(b) && !catchAllOf(b));
    const routes = [];
    const seen = new Set();
    for (const b of bindings) {
      if (!isGroupRoute(b)) continue;
      const jid = b.match.peer.id;
      if (seen.has(jid)) continue;
      const validExpected = expected.has(jid) && expected.get(jid) === b.agentId;
      if (validExpected || isRedundantMainRoute(jid, b.agentId)) {
        routes.push(b); // preserve existing valid (or redundant-but-valid main) route object + order
        seen.add(jid);
      }
    }
    for (const [jid, agentId] of expected) {
      if (!seen.has(jid)) { routes.push(makeGroupRoute(agentId, jid)); seen.add(jid); }
    }
    const catchAll = bindings.find(catchAllOf) || makeCatchAll(model.mainAgentId);
    return [...other, ...routes, catchAll];
  };

  return { drifts, patch };
}

// ── View 3: agents.list identity / mentionPatterns / workspace ──
export function diffAgents(model, config) {
  const drifts = [];
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const defaultsWorkspace = config?.agents?.defaults?.workspace;
  const byId = new Map(list.map((a) => [a.id, a]));
  // LIVE agents must be present + correct; ARCHIVED agents must be ABSENT (flagged + dropped).
  const registryIds = new Set(model.agents.filter((a) => !a.archived).map((a) => a.agentId));
  const archivedIds = new Set(model.agents.filter((a) => a.archived).map((a) => a.agentId));

  for (const ag of model.agents) {
    if (ag.archived) continue; // handled by the leftover-detection loop below
    const a = byId.get(ag.agentId);
    const base = `agents.list[id=${ag.agentId}]`;
    if (!a) {
      drifts.push({ view: 'agents', kind: 'missing-in-config', path: base, agentId: ag.agentId,
        expected: `identity ${ag.identityName}`, actual: undefined,
        message: `agent ${ag.agentId} in registry but not in openclaw.json agents.list` });
      continue;
    }
    if ((a.identity && a.identity.name) !== ag.identityName) {
      drifts.push({ view: 'agents', kind: 'identity.name', path: `${base}.identity.name`, agentId: ag.agentId,
        expected: ag.identityName, actual: a.identity && a.identity.name,
        message: `${ag.agentId}: identity.name expected ${ag.identityName}` });
    }
    if ((a.identity && a.identity.emoji) !== ag.identityEmoji) {
      drifts.push({ view: 'agents', kind: 'identity.emoji', path: `${base}.identity.emoji`, agentId: ag.agentId,
        expected: ag.identityEmoji, actual: a.identity && a.identity.emoji,
        message: `${ag.agentId}: identity.emoji expected ${ag.identityEmoji}` });
    }
    const mp = a.groupChat && a.groupChat.mentionPatterns;
    if (!arrEq(mp, ag.mentionPatterns)) {
      drifts.push({ view: 'agents', kind: 'mentionPatterns', path: `${base}.groupChat.mentionPatterns`,
        agentId: ag.agentId, expected: ag.mentionPatterns, actual: mp,
        message: `${ag.agentId}: mentionPatterns expected ${JSON.stringify(ag.mentionPatterns)}` });
    }
    const effWs = a.workspace != null ? a.workspace : defaultsWorkspace;
    if (effWs !== ag.workspaceAbs) {
      drifts.push({ view: 'agents', kind: 'workspace', path: `${base}.workspace`, agentId: ag.agentId,
        expected: ag.workspaceAbs, actual: effWs,
        message: `${ag.agentId}: effective workspace expected ${ag.workspaceAbs}, got ${effWs}` });
    }
  }
  for (const a of list) {
    if (registryIds.has(a.id)) continue;
    if (archivedIds.has(a.id)) {
      drifts.push({ view: 'agents', kind: 'archived', path: `agents.list[id=${a.id}]`,
        agentId: a.id, expected: undefined, actual: `identity ${a.identity && a.identity.name}`,
        message: `agent ${a.id} is archived in the registry but still present in openclaw.json agents.list` });
    } else {
      drifts.push({ view: 'agents', kind: 'in-config-not-registry', path: `agents.list[id=${a.id}]`,
        agentId: a.id, expected: undefined, actual: `identity ${a.identity && a.identity.name}`,
        message: `agent ${a.id} in openclaw.json but not in the registry` });
    }
  }

  // patch: CREATE a full agents.list row for a LIVE registry agent missing from config (newly
  // onboarded — id/name/identity/mentionPatterns + workspace when it differs from defaults), and
  // update identity/mentionPatterns for LIVE agents already present; add workspace only when the
  // effective (list-or-defaults) value is wrong (so `main`, which inherits defaults.workspace, stays
  // free of a redundant workspace key). Both paths share the SAME identity/mentionPatterns/workspace
  // derivation so a created row and an updated row are byte-identical. REMOVES archived agents'
  // leftover rows (targeted, by archived id). Never touches model/agentDir/defaults; never
  // auto-removes a truly-foreign agent (in config but not in the registry at all) — that stays
  // flagged only, preserving the old safety.
  const patch = (listClone) => {
    const cloneById = new Map(listClone.map((a) => [a.id, a]));
    for (const ag of model.agents) {
      if (ag.archived) continue;
      let a = cloneById.get(ag.agentId);
      if (!a) {
        // Newly-onboarded agent: build the row (identity/mentionPatterns/workspace filled in below,
        // same as the update path). `name` mirrors the id, matching every existing non-main entry.
        a = { id: ag.agentId, name: ag.agentId };
        listClone.push(a);
        cloneById.set(ag.agentId, a);
      }
      a.identity = { ...(a.identity || {}), name: ag.identityName, emoji: ag.identityEmoji };
      a.groupChat = { ...(a.groupChat || {}), mentionPatterns: ag.mentionPatterns.slice() };
      const effWs = a.workspace != null ? a.workspace : defaultsWorkspace;
      if (effWs !== ag.workspaceAbs) a.workspace = ag.workspaceAbs;
    }
    return listClone.filter((a) => !archivedIds.has(a.id));
  };

  return { drifts, patch };
}

// ── View 4: cron delivery targets ──
export function diffCron(model, cronJobs) {
  const drifts = [];
  const edits = [];
  const jobs = Array.isArray(cronJobs) ? cronJobs : [];
  const byId = new Map(model.agents.map((a) => [a.agentId, a]));

  for (const job of jobs) {
    const agent = byId.get(job.agentId);
    if (!agent || !agent.answering || agent.archived) continue; // not a live answering agent -> skip
    const expected = (agent.cronTargetJids && agent.cronTargetJids[job.name]) || agent.cronDefaultJid;
    const actual = job.delivery && job.delivery.to;
    if (!expected) continue; // no resolvable target (misconfig guarded elsewhere)
    if (actual !== expected) {
      const inGroups = agent.groupJids.includes(actual);
      drifts.push({ view: 'cron', kind: inGroups ? 'wrong-group' : 'foreign-group',
        path: `cron[${job.name}].delivery.to`, jobName: job.name, agentId: job.agentId,
        id: job.id, expected, actual,
        message: `cron ${job.name} (${job.agentId}) delivers to ${actual || '(none)'}, expected ${expected}` +
          (inGroups ? '' : ' — actual is NOT among the agent\'s groups') });
      edits.push({ id: job.id, name: job.name, agentId: job.agentId, to: expected });
    }
  }
  return { drifts, edits };
}

/**
 * Full sync computation. Returns:
 *   { drifts, cronEdits, patchedConfig, changedConfig }
 * patchedConfig is a deep clone of `config` with the three openclaw.json views rendered.
 * changedConfig is true iff patchedConfig differs from config (drives the "restart required" note).
 */
export function computeSync({ model, config, cronJobs }) {
  const g = diffGroups(model, config);
  const b = diffBindings(model, config);
  const a = diffAgents(model, config);
  const c = diffCron(model, cronJobs);

  const patched = JSON.parse(JSON.stringify(config));
  // groups
  if (patched.channels && patched.channels.whatsapp && patched.channels.whatsapp.accounts &&
      patched.channels.whatsapp.accounts.default) {
    patched.channels.whatsapp.accounts.default.groups = g.patch();
  }
  // bindings
  patched.bindings = b.patch();
  // agents.list
  if (patched.agents && Array.isArray(patched.agents.list)) {
    patched.agents.list = a.patch(patched.agents.list);
  }

  const drifts = [...g.drifts, ...b.drifts, ...a.drifts, ...c.drifts];
  const changedConfig = JSON.stringify(patched) !== JSON.stringify(config);
  return { drifts, cronEdits: c.edits, patchedConfig: patched, changedConfig };
}
