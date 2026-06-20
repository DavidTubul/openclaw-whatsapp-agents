import { test } from "node:test";
import assert from "node:assert/strict";
import { genId, normalize, FIELDS } from "./cases.mjs";

test("genId is deterministic & 12 hex chars", () => {
  const a = { customer_phone: "972500000000", product: "גרעינים שחורים", created: "2026-06-13T10:00:00Z" };
  const id1 = genId(a);
  const id2 = genId({ ...a });
  assert.equal(id1, id2);
  assert.match(id1, /^[0-9a-f]{12}$/);
});

test("genId differs by customer/product", () => {
  const base = { product: "p", created: "2026-06-13T10:00:00Z" };
  assert.notEqual(genId({ ...base, customer_phone: "1" }), genId({ ...base, customer_phone: "2" }));
});

test("normalize produces every field in order, nulls for missing", () => {
  const row = normalize({ id: "x", product: "אגוזים" });
  assert.deepEqual(Object.keys(row), FIELDS);
  assert.equal(row.product, "אגוזים");
  assert.equal(row.customer_phone, null);
});
