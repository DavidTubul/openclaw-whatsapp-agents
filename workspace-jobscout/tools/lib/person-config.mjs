// Resolve a person + load the per-run config the search tools all need, in one place.
// Replaces the identical `resolvePerson + readFileSync(sources) + readFileSync(locations) +
// buildLocationFilter` block previously copy-pasted in search.mjs / linkedin.mjs / telegram.mjs.
import { readFileSync } from 'node:fs';
import { resolvePerson } from './people.mjs';
import { buildLocationFilter } from './location-filter.mjs';

// Throws on unknown person or unreadable required config — callers run inside `main().catch(failJson)`,
// so the throw surfaces as the standard {ok:false,error} line and a non-zero exit.
export function loadPersonContext(id, { sources = false, locationFilter = false } = {}) {
  const person = resolvePerson(id);
  if (!person) throw new Error(`Unknown person "${id}"`);
  const ctx = { person };
  if (sources) ctx.sources = JSON.parse(readFileSync(person.paths.sources, 'utf8'));
  if (locationFilter) {
    ctx.locFilter = buildLocationFilter(JSON.parse(readFileSync(person.paths.locations, 'utf8')));
  }
  return ctx;
}
