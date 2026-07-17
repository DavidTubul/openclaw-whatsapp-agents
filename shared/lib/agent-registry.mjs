// shared/lib/agent-registry.mjs
//
// Central agent registry (v2): pure resolvers over a single registry.json.
// This module performs ONLY a one-time read of registry.json at load and then
// serves indexed lookups from memory — no per-call side effects, no network.
//
// v2 schema (see registry.example.json _doc). Two top-level collections:
//   groups:  symbolic-name -> { jid, label, requireMention, listenOnly?, routeAgentId?, systemPrompt? }
//   agents:  each entry references groups SYMBOLICALLY (primaryGroup + groups[] + listenGroups[]);
//            identity{name,emoji,mentionPatterns?}; cronTargets{default,<job-name>...}.
// The loader resolves every symbolic group ref to its jid so downstream consumers see the SAME
// normalized record shape as v1 (agentId, workspaceDir, primaryGroupId, groupIds, persona.name,
// owner, roster, fromLabel, keyPrefix, sessionStore, configPath, sessionHygiene, chatLog, selfEdit,
// ackReact, dataDir) — nothing downstream changed. New fields are additive: identity, primaryGroup,
// groups (symbolic), cronTargets (symbolic), listenGroupIds (resolved), listenerAgent.
//
// listenOnly groups are the shadow-`listener` agent's rooms: they live ONLY in the top-level groups
// map (+ the owning agent's listenGroups) and are NEVER added to the byGroup index, so
// getAgentByGroup(<listen-jid>) returns null — preserving the "listen group resolves to no answering
// agent" invariant. The `listener` agent has empty groupIds and is EXCLUDED from listAgents() unless
// {includeListenOnly:true} is passed, keeping every existing consumer at the same 5 answering bots.
//
// ARCHIVED (retirement) support: an agent entry with `archived: true` is RETIRED — its code/data are
// kept in the registry for a future revival, but it is invisible to every default accessor:
// excluded from listAgents() (even with {includeListenOnly:true}), from the byGroup index, and from
// getAgent(id) — pass {includeArchived:true} to any of them to reach it again. A top-level group
// with `archived: true` that is referenced ONLY by archived agents is likewise dropped from
// getGroups() by default (a group still referenced by a LIVE agent is never dropped, even if it
// carries the flag). resolveGroupRef/getGroupByName still resolve archived groups so a revival (flip
// the flag + registry-sync --apply) resolves cleanly. registry-sync builds its model with
// {includeArchived:true} so it can DETECT + REMOVE an archived agent's leftover openclaw.json wiring.
//
// Exports: getAgent, getAgentByGroup, listAgents, getGroups, getGroupByName, resolveGroupRef,
//          isPlaceholderJid, _loadRegistry (testing seam).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, '..', 'registry.json');
const EXAMPLE_REGISTRY_PATH = path.resolve(__dirname, '..', 'registry.example.json');

/**
 * The live registry if present, else the committed example (fresh-clone fallback).
 * registry.json is gitignored (it carries the owner phone + real group_ids); the
 * example ships placeholders so a clone degrades gracefully instead of throwing ENOENT.
 */
function defaultRegistryPath() {
  return existsSync(REGISTRY_PATH) ? REGISTRY_PATH : EXAMPLE_REGISTRY_PATH;
}

/** Resolve a repo-relative path to absolute; leaves absolute paths untouched. */
function abs(repoRoot, p) {
  if (p == null) return undefined;
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

/** Build the normalized top-level groups map: symbolic-name -> { name, jid, label, requireMention,
 *  listenOnly, routeAgentId, systemPrompt }. Kept close to the raw shape; `name` echoes the key. */
function normalizeGroups(rawGroups) {
  const out = {};
  for (const [name, g] of Object.entries(rawGroups || {})) {
    if (!g || typeof g !== 'object') continue;
    out[name] = {
      name,
      jid: g.jid,
      label: g.label || name,
      requireMention: g.listenOnly ? false : !!g.requireMention,
      listenOnly: !!g.listenOnly,
      archived: !!g.archived,
      ...(g.routeAgentId ? { routeAgentId: g.routeAgentId } : {}),
      ...(g.systemPrompt != null ? { systemPrompt: g.systemPrompt } : {}),
    };
  }
  return out;
}

/** Symbolic group ref -> jid. Passes through an already-resolved jid ("...@g.us"). null if unknown. */
function resolveRef(groups, ref) {
  if (ref == null) return undefined;
  if (typeof ref === 'string' && ref.endsWith('@g.us')) return ref; // already a jid
  const g = groups[ref];
  return g ? g.jid : undefined;
}

/** Normalize one raw registry entry into a full agent record (v2 -> normalized). */
function normalize(raw, repoRoot, topOwner, groups) {
  const agentId = raw.agentId;
  const workspaceDir = abs(repoRoot, raw.workspaceDir);

  // Symbolic -> jid resolution. `groups` are the answering rooms; listenGroups are shadow rooms.
  const symGroups = Array.isArray(raw.groups) ? raw.groups.slice() : [];
  const groupIds = symGroups.map((r) => resolveRef(groups, r)).filter(Boolean);
  const symPrimary = raw.primaryGroup || symGroups[0];
  const primaryGroupId = resolveRef(groups, symPrimary) || groupIds[0];
  const symListen = Array.isArray(raw.listenGroups) ? raw.listenGroups.slice() : [];
  const listenGroupIds = symListen.map((r) => resolveRef(groups, r)).filter(Boolean);

  const roster = { type: (raw.roster && raw.roster.type) || 'none' };
  if (raw.roster && raw.roster.file) roster.file = abs(repoRoot, raw.roster.file);
  if (raw.roster && raw.roster.fallbackFile) roster.fallbackFile = abs(repoRoot, raw.roster.fallbackFile);

  const owner = raw.owner || topOwner || { label: 'david' };

  // identity is the single source for the wake-word/display name; persona.name aliases it (compat).
  const idName = raw.identity && raw.identity.name;
  const identity = {
    name: idName,
    emoji: raw.identity && raw.identity.emoji,
    mentionPatterns:
      raw.identity && Array.isArray(raw.identity.mentionPatterns) && raw.identity.mentionPatterns.length
        ? raw.identity.mentionPatterns.slice()
        : (idName ? [idName] : []),
  };

  return {
    agentId,
    workspaceDir,
    dataDir: path.join(workspaceDir, 'data'),
    primaryGroupId,
    groupIds,
    // New (additive) — symbolic refs + resolved listen rooms + identity/cron wiring:
    primaryGroup: symPrimary,
    groups: symGroups,
    listenGroups: symListen,
    listenGroupIds,
    identity,
    cronTargets: raw.cronTargets || {},
    // An agent that serves NO answering group (the shadow `listener`) — excluded from listAgents()
    // by default so reflect/boot-notify/transcribe/session-hygiene keep operating on the 5 real bots.
    listenerAgent: groupIds.length === 0,
    // Retired: kept in the registry for revival but hidden from every default accessor + the byGroup
    // index (see the header). registry-sync removes its leftover openclaw.json wiring.
    archived: !!raw.archived,
    // persona.name kept for every consumer that reads it (chat-log, reply-policy, reflect, ack-react).
    persona: { name: idName },
    owner: { e164: owner.e164, label: owner.label || 'david' },
    roster,
    fromLabel: {
      inbound: (raw.fromLabel && raw.fromLabel.inbound) || 'david',
      outbound: (raw.fromLabel && raw.fromLabel.outbound) || idName,
    },
    keyPrefix: `agent:${agentId}:`,
    sessionStore: `~/.openclaw/agents/${agentId}/sessions`,
    configPath: abs(repoRoot, raw.configPath),
    sessionHygiene: raw.sessionHygiene || null,
    // Optional per-agent overrides consumed by shared consumers (chat-log hook / self-edit):
    // lets a NEW bot be fully wired from the registry alone, with no shared-code edits.
    chatLog: raw.chatLog || null,
    selfEdit: raw.selfEdit || null,
    // ack-react policy: { enabled?: boolean (default true), scope?: "mentions" | "all" (default
    // "mentions") }. Absent block ⇒ enabled + mentions (ack on messages addressed to the bot).
    ackReact: raw.ackReact || null,
  };
}

/**
 * Load + index the registry. Pure: takes a path, returns indexes; no module-level
 * mutation beyond the memoized default below. Exposed for tests.
 */
export function _loadRegistry(registryPath = defaultRegistryPath()) {
  const json = JSON.parse(readFileSync(registryPath, 'utf8'));
  const repoRoot = json._repoRoot || path.resolve(__dirname, '..', '..');
  const topOwner = json.owner;
  const groups = normalizeGroups(json.groups);
  const records = (json.agents || []).map((raw) => normalize(raw, repoRoot, topOwner, groups));

  const byId = new Map();
  const byGroup = new Map();
  // Symbolic group names referenced by a LIVE (non-archived) agent — a group flagged archived is only
  // dropped from getGroups() when NO live agent still references it (revival safety).
  const liveGroupRefs = new Set();
  for (const rec of records) {
    byId.set(rec.agentId, rec); // byId indexes every record; getAgent() gates on archived, not this map
    if (rec.archived) continue; // an archived agent owns no routable group and anchors no live ref
    // ONLY answering groups feed the group index. listenOnly groups (and the listener's empty
    // groupIds) are deliberately excluded so getAgentByGroup(<listen-jid>) === null.
    for (const g of rec.groupIds) {
      if (!byGroup.has(g)) byGroup.set(g, rec); // first writer wins; jids are unique across agents
    }
    if (rec.primaryGroup) liveGroupRefs.add(rec.primaryGroup);
    for (const gname of rec.groups) liveGroupRefs.add(gname);
    for (const gname of rec.listenGroups) liveGroupRefs.add(gname);
  }
  return { records, byId, byGroup, groups, liveGroupRefs };
}

// Memoized default-path index (the live registry).
let _idx = null;
function idx() {
  if (!_idx) _idx = _loadRegistry();
  return _idx;
}

/**
 * getAgent(agentId, opts) -> record | null
 * By default an ARCHIVED agent resolves to null (as if retired); pass {includeArchived:true} to reach
 * it (revival / registry-sync leftover-wiring detection).
 */
export function getAgent(agentId, opts = {}) {
  const rec = idx().byId.get(agentId) || null;
  if (rec && rec.archived && !opts.includeArchived) return null;
  return rec;
}

/**
 * getAgentByGroup(groupJid) -> record | null
 * Matches an ANSWERING group (primaryGroupId or any groupIds entry; digit has 2). Never resolves a
 * listenOnly jid — those are absent from the index by design.
 */
export function getAgentByGroup(groupJid) {
  return idx().byGroup.get(groupJid) || null;
}

/**
 * listAgents(opts) -> record[] (registry order).
 * By default returns only LIVE ANSWERING agents. Options (independent, both default false):
 *   { includeListenOnly:true } also includes the shadow `listener` agent (registry-sync agents.list).
 *   { includeArchived:true }   also includes RETIRED agents (registry-sync leftover-wiring removal).
 * Archived agents are excluded even when includeListenOnly is set — the two flags are orthogonal.
 */
export function listAgents(opts = {}) {
  let all = idx().records.slice();
  if (!opts.includeArchived) all = all.filter((r) => !r.archived);
  if (!opts.includeListenOnly) all = all.filter((r) => !r.listenerAgent);
  return all;
}

/**
 * getGroups(opts) -> normalized symbolic groups map { name -> { name, jid, label, requireMention, ... } }
 * By default a group flagged `archived:true` AND no longer referenced by any live agent is omitted;
 * pass { includeArchived:true } to get every group (registry-sync). A flagged group still referenced
 * by a live agent is always returned (revival safety).
 */
export function getGroups(opts = {}) {
  const i = idx();
  const g = i.groups;
  // shallow clone so callers can't mutate the memoized index
  const out = {};
  for (const [k, v] of Object.entries(g)) {
    if (!opts.includeArchived && v.archived && !i.liveGroupRefs.has(k)) continue;
    out[k] = { ...v };
  }
  return out;
}

/** getGroupByName(name) -> normalized group | null */
export function getGroupByName(name) {
  const g = idx().groups[name];
  return g ? { ...g } : null;
}

/** resolveGroupRef(nameOrJid) -> jid | null. Accepts a symbolic name or a pass-through jid. */
export function resolveGroupRef(ref) {
  return resolveRef(idx().groups, ref) || null;
}

/**
 * True when `jid` is absent or a registry PLACEHOLDER rather than a real group jid. On a fresh clone
 * the loader falls back to registry.example.json, whose group jids are literals like
 * `<ZORRO_GROUP_ID>@g.us`; any tool that would `openclaw message send` to a resolved group MUST treat
 * a placeholder as "no group configured" and cleanly skip rather than send to a garbage target.
 * (Shared by boot-notify's resolveGroup and zorro's remind-pending guard.)
 */
export function isPlaceholderJid(jid) {
  return typeof jid !== 'string' || jid.length === 0 || jid.startsWith('<');
}
