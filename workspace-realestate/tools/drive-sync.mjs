#!/usr/bin/env node
// drive-sync.mjs — sync the owner's Google Drive deal folder into the workspace via rclone.
//
// Usage:
//   node tools/drive-sync.mjs [--dry-run] [--verbose]
//
// Reads .config/bot.json → drive.{remote, folder, local_dir}, runs
//   rclone sync "<remote>:<folder>" "<abs local_dir>" --progress
// so the agent can read the deal documents locally. After a successful sync it writes
// deal-data/.manifest.json describing the synced files.

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = join(WORKSPACE_ROOT, ".config", "bot.json");

/** Build the rclone argv (pure — unit-tested). */
export function buildSyncArgs({ remote, folder, localDir, dryRun = false, verbose = false }) {
  const args = ["sync", `${remote}:${folder}`, localDir, "--progress"];
  if (dryRun) args.push("--dry-run");
  if (verbose) args.push("--verbose");
  return args;
}

/** Resolve the configured local_dir against the workspace root (pure — unit-tested). */
export function resolveLocalDir(config, root) {
  const dir = config?.drive?.local_dir ?? "deal-data";
  return isAbsolute(dir) ? dir : resolve(root, dir);
}

// ---- CLI side-effects below (only run when invoked as the main module) ----

function execFileP(cmd, args) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => res({ err, stdout, stderr }));
  });
}

async function rcloneAvailable() {
  const { err } = await execFileP("rclone", ["version"]);
  return !err;
}

async function remoteConfigured(remote) {
  const { err, stdout } = await execFileP("rclone", ["listremotes"]);
  if (err) return false;
  const wanted = `${remote}:`;
  return stdout.split(/\r?\n/).map((l) => l.trim()).includes(wanted);
}

function printRcloneMissing() {
  process.stderr.write(
    "\n❌ rclone לא מותקן / לא נמצא ב-PATH.\n" +
    "   rclone is not installed or not on PATH.\n\n" +
    "   התקנה (install):  curl https://rclone.org/install.sh | sudo bash\n" +
    "                     או: sudo apt install rclone / brew install rclone\n\n" +
    "   הגדרה (configure): rclone config\n" +
    "      → n) New remote → choose 'drive' (Google Drive), name it as in bot.json (drive.remote).\n\n"
  );
}

function printRemoteMissing(remote) {
  process.stderr.write(
    `\n❌ ה-remote "${remote}" לא מוגדר ב-rclone.\n` +
    `   The rclone remote "${remote}" is not configured.\n\n` +
    `   הרץ (run):  rclone config\n` +
    `      → n) New remote → name: ${remote} → type: drive (Google Drive) → follow the OAuth flow.\n` +
    `   בדיקה (verify): rclone listremotes  → should list "${remote}:"\n\n`
  );
}

function runSync(args, { verbose }) {
  return new Promise((res) => {
    const child = spawn("rclone", args, { stdio: verbose ? "inherit" : ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => res({ code: 1, err }));
    child.on("close", (code) => res({ code }));
  });
}

/** Walk a directory tree (skip dotfiles/dotdirs) → [{ path (relative), size }]. */
async function walkFiles(root, base = root) {
  const out = [];
  let entries = [];
  try { entries = await readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // skip dotfiles/dotdirs (incl. .manifest.json)
    const abs = join(base, e.name);
    if (e.isDirectory()) {
      out.push(...await walkFiles(root, abs));
    } else if (e.isFile()) {
      let size = 0;
      try { size = (await stat(abs)).size; } catch { /* ignore */ }
      out.push({ path: abs.slice(root.length + 1), size });
    }
  }
  return out;
}

function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const verbose = argv.includes("--verbose");

  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (e) {
    process.stderr.write(`❌ Could not read config at ${CONFIG_PATH}: ${e.message}\n`);
    process.exit(1);
    return;
  }

  const remote = config?.drive?.remote;
  // folder is optional: "" (or omitted) means the remote root — valid when the rclone
  // remote pins root_folder_id (e.g. a service account scoped to one shared folder).
  const folder = config?.drive?.folder ?? "";
  if (!remote) {
    process.stderr.write("❌ bot.json is missing drive.remote.\n");
    process.exit(1);
    return;
  }
  const localDir = resolveLocalDir(config, WORKSPACE_ROOT);

  if (!(await rcloneAvailable())) {
    printRcloneMissing();
    process.exit(1);
    return;
  }
  if (!(await remoteConfigured(remote))) {
    printRemoteMissing(remote);
    process.exit(1);
    return;
  }

  const args = buildSyncArgs({ remote, folder, localDir, dryRun, verbose });
  process.stdout.write(`▶ rclone ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
  const { code } = await runSync(args, { verbose });
  if (code !== 0) {
    process.stderr.write(`❌ rclone sync exited with code ${code}.\n`);
    process.exit(code || 1);
    return;
  }

  if (dryRun) {
    process.stdout.write("✓ dry-run complete — no manifest written.\n");
    return;
  }

  // Write the manifest by walking the local dir.
  const files = await walkFiles(localDir);
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
  const manifest = { synced_at: new Date().toISOString(), files };
  try {
    await writeFile(join(localDir, ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(`⚠ sync ok but failed to write manifest: ${e.message}\n`);
  }
  process.stdout.write(`✓ Synced ${files.length} file(s), ${fmtBytes(totalSize)} total → ${localDir}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`❌ ${e?.message || e}\n`);
    process.exit(1);
  });
}
