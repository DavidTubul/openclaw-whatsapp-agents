// Per-person path & capability resolver — single source of truth for the people registry.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Derive the workspace root from this module's location (tools/lib/people.mjs → ../../).
// Robust against the workspace dir being renamed (was hardcoded to /open_claw/workspace).
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_PATH = `${WORKSPACE}/.config/people.json`;

export function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

function withPaths(p) {
  const base = `${WORKSPACE}/people/${p.id}`;
  return {
    ...p,
    paths: {
      base,
      profileDir: `${base}/profile`,
      cvSummary: `${base}/profile/cv-summary.json`,
      profileMd: `${base}/profile/profile.md`,
      sources: `${base}/sources.json`,
      locations: `${base}/allowed-locations.json`,
      dataDir: `${base}/data`,
      ledger: `${base}/data/sent-suggestions.json`,
      telegramState: `${base}/data/telegram-state.json`,
      gmailState: `${base}/data/gmail-state.json`,
      linkedinSeen: `${base}/data/linkedin-seen.json`,
      dropsLog: `${base}/data/drops.jsonl`,
      watchlist: `${base}/company-watchlist.json`,
      atsSeen: `${base}/data/ats-seen.json`,
    },
  };
}

export function resolvePerson(id, registry = loadRegistry()) {
  const p = registry.people.find((x) => x.id === id);
  return p ? withPaths(p) : null;
}

export function listEnabled(registry = loadRegistry()) {
  return registry.people.filter((p) => p.enabled).map(withPaths);
}

const digits = (s) => String(s || '').replace(/\D/g, '');

// fromMe → the enabled owner; known e164 → that enabled person; else null (unknown sender).
export function personByE164(e164, { fromMe = false } = {}, registry = loadRegistry()) {
  if (fromMe) {
    const owner = registry.people.find((p) => p.role === 'owner' && p.enabled);
    if (owner) return withPaths(owner);
  }
  const d = digits(e164);
  if (d) {
    const m = registry.people.find(
      (p) => p.enabled && Array.isArray(p.match_e164) && p.match_e164.some((x) => digits(x) === d),
    );
    if (m) return withPaths(m);
  }
  return null;
}

export function sharedConfig(registry = loadRegistry()) {
  return registry.shared || {};
}
