// Shared center-Israel location filter, used by search.mjs and telegram.mjs.
// Takes the parsed allowed-locations.json and a text blob; decides keep/drop.

export function buildLocationFilter(loc) {
  const allowedEn = (loc?.allowed?.en || []).map((s) => s.toLowerCase());
  const allowedHe = loc?.allowed?.he || [];
  const blockedEn = (loc?.blocked?.en || []).map((s) => s.toLowerCase());
  const blockedHe = loc?.blocked?.he || [];
  const remoteGlobal = (loc?.remote_handling?.patterns_remote_global || []).map((s) => s.toLowerCase());
  const allowedOriginal = [...(loc?.allowed?.en || []), ...(loc?.allowed?.he || [])];
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
