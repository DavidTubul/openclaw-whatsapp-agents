// shared/lib/paths.mjs
//
// Single source for repo-root paths shared across the shared/ libs, hooks and workspace tools.
// Historically FIVE files each recomputed the repo-root `openclaw` launcher path from their own
// location (shared/lib/ack-react.mjs, shared/lib/session-hygiene.mjs, shared/tools/boot-notify.mjs,
// workspace-jobscout/tools/search.mjs, workspace-quitsmoke/tools/streaks.mjs). They now all import
// `launcherPath` from here so the derivation lives in exactly ONE place.
//
// This file lives at <repo>/shared/lib/, so `../../openclaw` resolves to the repo-root launcher
// wrapper (`./openclaw`, which does `nvm use 22 -> exec openclaw CLI`).

import { fileURLToPath } from 'node:url';

/** Absolute path to the repo-root `openclaw` launcher wrapper. */
export const launcherPath = fileURLToPath(new URL('../../openclaw', import.meta.url));
