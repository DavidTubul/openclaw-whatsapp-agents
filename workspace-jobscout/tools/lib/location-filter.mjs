// Shared center-Israel location filter, used by search.mjs and telegram.mjs.
// Takes the parsed allowed-locations.json and a text blob; decides keep/drop.

export function buildLocationFilter(loc) {
  // Tolerate a FLAT-ARRAY schema: ["מרכז","רחובות",...] = a bare allow-list (he/en mixed),
  // no block-list. Some person configs were saved this way (yuval's was), and without this
  // the object-shaped reads below all yield [] → the filter silently becomes a NO-OP that
  // keeps EVERY location (incl. Jerusalem / abroad / global-remote). Normalize to the object
  // shape first so a flat array behaves as an allow-list (evaluateLocation lowercases each
  // allowedOriginal entry itself, so mixing en+he under `he` still matches both).
  if (Array.isArray(loc)) loc = { allowed: { he: loc.filter((s) => typeof s === 'string') } };
  // Also tolerate allowed/blocked given as a flat array instead of {en,he}.
  const norm = (v) => (Array.isArray(v) ? { he: v } : (v || {}));
  const allowed = norm(loc?.allowed);
  const blocked = norm(loc?.blocked);
  const allowedEn = (allowed.en || []).map((s) => s.toLowerCase());
  const allowedHe = allowed.he || [];
  const blockedEn = (blocked.en || []).map((s) => s.toLowerCase());
  const blockedHe = blocked.he || [];
  const remoteGlobal = (loc?.remote_handling?.patterns_remote_global || []).map((s) => s.toLowerCase());
  const allowedOriginal = [...(allowed.en || []), ...(allowed.he || [])];
  return { allowedEn, allowedHe, blockedEn, blockedHe, remoteGlobal, allowedOriginal };
}

// Returns { keep: bool, location: string }
export function evaluateLocation(text, f) {
  const lower = text.toLowerCase();

  let matchedAllowed = '';
  for (const city of f.allowedOriginal) {
    const lc = city.toLowerCase();
    if (lower.includes(lc) || text.includes(city)) {
      matchedAllowed = city;
      break;
    }
  }
  const hasAllowed = matchedAllowed !== '';

  let hasBlocked = false;
  for (const c of f.blockedEn) {
    if (lower.includes(c)) { hasBlocked = true; break; }
  }
  if (!hasBlocked) {
    for (const c of f.blockedHe) {
      if (text.includes(c)) { hasBlocked = true; break; }
    }
  }

  let hasGlobalRemote = false;
  for (const p of f.remoteGlobal) {
    if (lower.includes(p)) { hasGlobalRemote = true; break; }
  }

  if (hasBlocked && !hasAllowed) return { keep: false, location: '' };
  if (hasGlobalRemote && !hasAllowed) return { keep: false, location: '' };

  return { keep: true, location: matchedAllowed };
}
