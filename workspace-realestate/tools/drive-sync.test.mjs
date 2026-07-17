import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyncArgs, resolveLocalDir } from "./drive-sync.mjs";

test("buildSyncArgs produces the base rclone sync argv", () => {
  const args = buildSyncArgs({ remote: "gdrive", folder: "RealEstate/MyDeal", localDir: "/abs/deal-data" });
  assert.deepEqual(args, ["sync", "gdrive:RealEstate/MyDeal", "/abs/deal-data", "--progress"]);
});

test("buildSyncArgs appends --dry-run when requested", () => {
  const args = buildSyncArgs({ remote: "gdrive", folder: "f", localDir: "/abs", dryRun: true });
  assert.ok(args.includes("--dry-run"));
  // ordering: remote spec, then localDir, then flags
  assert.equal(args[0], "sync");
  assert.equal(args[1], "gdrive:f");
  assert.equal(args[2], "/abs");
});

test("buildSyncArgs omits --dry-run by default", () => {
  assert.ok(!buildSyncArgs({ remote: "g", folder: "f", localDir: "/x" }).includes("--dry-run"));
});

test("buildSyncArgs appends --verbose only when requested", () => {
  assert.ok(buildSyncArgs({ remote: "g", folder: "f", localDir: "/x", verbose: true }).includes("--verbose"));
  assert.ok(!buildSyncArgs({ remote: "g", folder: "f", localDir: "/x" }).includes("--verbose"));
});

test("buildSyncArgs combines dry-run and verbose", () => {
  const args = buildSyncArgs({ remote: "g", folder: "f", localDir: "/x", dryRun: true, verbose: true });
  assert.ok(args.includes("--dry-run"));
  assert.ok(args.includes("--verbose"));
});

test("resolveLocalDir resolves a relative local_dir against the workspace root", () => {
  const root = "/repo/workspace-realestate";
  const dir = resolveLocalDir({ drive: { local_dir: "deal-data" } }, root);
  assert.equal(dir, "/repo/workspace-realestate/deal-data");
});

test("resolveLocalDir keeps an absolute local_dir as-is", () => {
  const dir = resolveLocalDir({ drive: { local_dir: "/var/data/deals" } }, "/some/root");
  assert.equal(dir, "/var/data/deals");
});

test("resolveLocalDir falls back to deal-data when local_dir is missing", () => {
  const root = "/some/root";
  assert.equal(resolveLocalDir({ drive: {} }, root), "/some/root/deal-data");
  assert.equal(resolveLocalDir({}, root), "/some/root/deal-data");
});
