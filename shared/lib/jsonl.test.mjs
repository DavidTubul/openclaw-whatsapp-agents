import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonl, writeJsonl } from "./jsonl.mjs";

function tmp() { return join(mkdtempSync(join(tmpdir(), "jsonl-")), "f.jsonl"); }

test("readJsonl: missing file → []", () => {
  assert.deepEqual(readJsonl("/no/such/file.jsonl"), []);
});

test("readJsonl: parses lines, skips blank/whitespace-only/corrupt", () => {
  const p = tmp();
  writeFileSync(p, '{"a":1}\n\n   \n{"b":2}\nnot json\n{"c":3}\n');
  assert.deepEqual(readJsonl(p), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("writeJsonl: compact one-object-per-line, single trailing newline", () => {
  const p = tmp();
  writeJsonl(p, [{ a: 1 }, { b: 2 }]);
  assert.equal(readFileSync(p, "utf8"), '{"a":1}\n{"b":2}\n');
});

test("writeJsonl: empty rows → empty file (no trailing newline)", () => {
  const p = tmp();
  writeJsonl(p, []);
  assert.equal(readFileSync(p, "utf8"), "");
});

test("round-trip: writeJsonl then readJsonl preserves rows", () => {
  const p = tmp();
  const rows = [{ id: "x", n: 1 }, { id: "y", n: 2 }, { id: "z", n: 3 }];
  writeJsonl(p, rows);
  assert.deepEqual(readJsonl(p), rows);
});

test("byte-compat: writeJsonl output equals the former inline one-liner", () => {
  const p = tmp();
  const rows = [{ a: 1 }, { b: 2 }, { c: 3 }];
  writeJsonl(p, rows);
  const expected = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  assert.equal(readFileSync(p, "utf8"), expected);
});

test("writeJsonl creates parent directories (atomic primitive)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-"));
  try {
    const p = join(dir, "nested", "deep", "f.jsonl");
    writeJsonl(p, [{ ok: true }]);
    assert.deepEqual(readJsonl(p), [{ ok: true }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
