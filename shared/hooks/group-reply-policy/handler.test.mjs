// shared/hooks/group-reply-policy/handler.test.mjs
//
// Tests the shared group-reply-policy bootstrap hook end-to-end against the REAL
// registry. Verifies that the policy text is appended to the AGENTS.md bootstrap
// entry (in place), that the file is read from .path when .content is absent,
// that other bootstrap entries and non-AGENTS files are untouched, and that
// missing-agent / malformed events are safe no-ops without throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import groupReplyPolicy from "./handler.js";
import { buildPolicyText } from "../../lib/reply-policy.mjs";
import { getAgent } from "../../lib/agent-registry.mjs";

function bootstrapEvent(agentId, bootstrapFiles) {
  return { type: "agent", action: "bootstrap", context: { agentId, bootstrapFiles } };
}

test("appends the policy to the AGENTS.md entry's .content for zorro", async () => {
  const agent = getAgent("zorro");
  assert.ok(agent, "zorro must be registered");
  const expectedPolicy = buildPolicyText(agent);

  const agentsEntry = { name: "AGENTS.md", path: "/ws/zorro/AGENTS.md", content: "# AGENTS\nbase rules" };
  const soulEntry = { name: "SOUL.md", path: "/ws/zorro/SOUL.md", content: "soul" };
  const files = [soulEntry, agentsEntry];

  await groupReplyPolicy(bootstrapEvent("zorro", files));

  assert.equal(agentsEntry.content, "# AGENTS\nbase rules" + "\n\n" + expectedPolicy);
  // policy actually present
  assert.ok(agentsEntry.content.includes("מדיניות תשובה בקבוצה"));
  // other entries untouched; array mutated in place (same refs)
  assert.equal(soulEntry.content, "soul");
  assert.equal(files[1], agentsEntry);
});

test("reads the file at .path when .content is absent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "grp-policy-"));
  const agentsPath = path.join(dir, "AGENTS.md");
  writeFileSync(agentsPath, "# from disk\nrule", "utf8");

  const agentsEntry = { name: "AGENTS.md", path: agentsPath };
  const files = [agentsEntry];

  await groupReplyPolicy(bootstrapEvent("zorro", files));

  const expectedPolicy = buildPolicyText(getAgent("zorro"));
  assert.equal(agentsEntry.content, "# from disk\nrule" + "\n\n" + expectedPolicy);
});

test("matches AGENTS.md by basename even with a full path and no name field", async () => {
  const agentsEntry = { path: "/abs/workspace-quitsmoke/AGENTS.md", content: "x" };
  const files = [agentsEntry];
  await groupReplyPolicy(bootstrapEvent("main", files));
  assert.ok(agentsEntry.content.startsWith("x\n\n"));
  assert.ok(agentsEntry.content.includes("מדיניות תשובה בקבוצה"));
});

test("missing / unregistered agent is a safe no-op (no mutation, no throw)", async () => {
  const agentsEntry = { name: "AGENTS.md", path: "/ws/x/AGENTS.md", content: "untouched" };
  const files = [agentsEntry];

  await assert.doesNotReject(() => groupReplyPolicy(bootstrapEvent("nope-not-an-agent", files)));
  await assert.doesNotReject(() => groupReplyPolicy(bootstrapEvent(undefined, files)));
  assert.equal(agentsEntry.content, "untouched");
});

test("never throws on malformed events / no AGENTS.md entry", async () => {
  await assert.doesNotReject(() => groupReplyPolicy(undefined));
  await assert.doesNotReject(() => groupReplyPolicy({}));
  await assert.doesNotReject(() => groupReplyPolicy({ context: {} }));
  // valid agent but bootstrapFiles missing
  await assert.doesNotReject(() => groupReplyPolicy({ context: { agentId: "zorro" } }));
  // valid agent, files present but no AGENTS.md -> no-op (no throw)
  const files = [{ name: "SOUL.md", content: "s" }];
  await assert.doesNotReject(() => groupReplyPolicy(bootstrapEvent("zorro", files)));
  assert.equal(files[0].content, "s");
});

test("does not push a new bootstrap file (only mutates the existing AGENTS.md)", async () => {
  const files = [
    { name: "AGENTS.md", content: "a" },
    { name: "SOUL.md", content: "s" },
  ];
  await groupReplyPolicy(bootstrapEvent("zorro", files));
  assert.equal(files.length, 2);
});
