import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpiryDate, daysUntil, decideCompensation } from "./policy.mjs";

const POLICY = { min_days_to_expiry: 60, replacement_packages: 2, require_front_and_back: true, max_claims_per_phone_per_period: 1 };

test("parseExpiryDate — full day formats (Israeli day-first)", () => {
  assert.equal(parseExpiryDate("31/12/2026"), "2026-12-31");
  assert.equal(parseExpiryDate("31.12.2026"), "2026-12-31");
  assert.equal(parseExpiryDate("05-06-2026"), "2026-06-05");
  assert.equal(parseExpiryDate("2026-12-31"), "2026-12-31");
});

test("parseExpiryDate — month/year only → end of month", () => {
  assert.equal(parseExpiryDate("12/2026"), "2026-12-31");
  assert.equal(parseExpiryDate("06/26"), "2026-06-30");
  assert.equal(parseExpiryDate("02/2026"), "2026-02-28"); // not a leap year
});

test("parseExpiryDate — junk → null", () => {
  assert.equal(parseExpiryDate(""), null);
  assert.equal(parseExpiryDate(null), null);
  assert.equal(parseExpiryDate("טרי מאוד"), null);
  assert.equal(parseExpiryDate("13/13/2026"), null);
});

test("daysUntil", () => {
  assert.equal(daysUntil("2026-07-01", "2026-06-01"), 30);
  assert.equal(daysUntil("2026-06-01", "2026-07-01"), -30);
  assert.equal(daysUntil(null, "2026-06-01"), null);
});

test("decide — eligible: far expiry, both photos, authentic, no prior claims", () => {
  const r = decideCompensation(
    { expiry: "31/12/2026", today: "2026-06-13", hasFront: true, hasBack: true, authentic: true, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, true);
  assert.equal(r.packages, 2);
  assert.equal(r.status, "מאושר - לשליחה");
  assert.ok(r.days_to_expiry >= 60);
});

test("decide — not authentic → human review, no packages", () => {
  const r = decideCompensation(
    { expiry: "31/12/2026", today: "2026-06-13", hasFront: true, hasBack: true, authentic: false, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.equal(r.packages, 0);
  assert.equal(r.status, "ממתין לבדיקת אדם");
});

test("decide — missing back photo → human review", () => {
  const r = decideCompensation(
    { expiry: "31/12/2026", today: "2026-06-13", hasFront: true, hasBack: false, authentic: true, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.match(r.reason, /חזית או גב/);
});

test("decide — repeat claimant over quota → human review", () => {
  const r = decideCompensation(
    { expiry: "31/12/2026", today: "2026-06-13", hasFront: true, hasBack: true, authentic: true, priorClaims: 1 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.match(r.reason, /מכסת התביעות/);
});

test("decide — near expiry (< min) → not automatic, human review", () => {
  const r = decideCompensation(
    { expiry: "01/07/2026", today: "2026-06-13", hasFront: true, hasBack: true, authentic: true, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.days_to_expiry < 60);
  assert.match(r.reason, /תוקף קרוב/);
});

test("decide — already expired → human review", () => {
  const r = decideCompensation(
    { expiry: "01/01/2026", today: "2026-06-13", hasFront: true, hasBack: true, authentic: true, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.match(r.reason, /פג תוקף/);
});

test("decide — unreadable expiry → human review", () => {
  const r = decideCompensation(
    { expiry: "לא ברור", today: "2026-06-13", hasFront: true, hasBack: true, authentic: true, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.match(r.reason, /לקרוא|לפענח/);
});

test("decide — authenticity OMITTED (undefined) → fail-closed human review, no payout", () => {
  // Regression: an otherwise-eligible bag where the LLM forgot to emit `authentic` must NOT pay
  // out. Before the fail-closed fix, `authentic === false` only caught an explicit spoof verdict,
  // so an omitted field fell through to a full 2-package approval.
  const r = decideCompensation(
    { expiry: "31/12/2026", today: "2026-06-13", hasFront: true, hasBack: true, priorClaims: 0 },
    POLICY,
  );
  assert.equal(r.eligible, false);
  assert.equal(r.packages, 0);
  assert.equal(r.status, "ממתין לבדיקת אדם");
});
