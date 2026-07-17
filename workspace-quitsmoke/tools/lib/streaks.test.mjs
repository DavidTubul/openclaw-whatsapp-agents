import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysBetween, addDays, computeCleanDays, applyCheckin, newMember,
  crossedMilestones, leaderboard, pendingMembers, aggregateStats,
  resolveMember, slugify, MILESTONES,
} from "./streaks.mjs";

test("daysBetween / addDays", () => {
  assert.equal(daysBetween("2026-06-01", "2026-06-26"), 25);
  assert.equal(daysBetween("2026-06-26", "2026-06-01"), -25);
  assert.equal(daysBetween("2026-06-26", "2026-06-26"), 0);
  assert.equal(daysBetween("bad", "2026-06-26"), null);
  assert.equal(addDays("2026-06-26", 1), "2026-06-27");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("computeCleanDays is derived from quit_date and never negative", () => {
  const m = { quit_date: "2026-06-20" };
  assert.equal(computeCleanDays(m, "2026-06-26"), 6);
  assert.equal(computeCleanDays(m, "2026-06-20"), 0);
  assert.equal(computeCleanDays(m, "2026-06-19"), 0); // future quit_date → 0, not negative
  assert.equal(computeCleanDays({}, "2026-06-26"), 0);
});

test("newMember shape", () => {
  const m = newMember({ name: "  דני  ", e164: "+972-50-123-4567", quitDate: "2026-06-26", nowIso: "2026-06-26T08:00:00Z" });
  assert.equal(m.member_name, "דני");
  assert.equal(m.e164, "972501234567");
  assert.equal(m.quit_date, "2026-06-26");
  assert.equal(m.longest_streak, 0);
  assert.equal(m.total_resets, 0);
  assert.equal(m.last_check, null);
  assert.ok(m.id);
});

test("applyCheckin clean: stamps check, banks longest, no drift", () => {
  const m = newMember({ name: "דני", e164: "", quitDate: "2026-06-20", nowIso: "x" });
  const r = applyCheckin(m, "clean", "2026-06-26");
  assert.equal(r.wasRelapse, false);
  assert.equal(r.cleanDays, 6);
  assert.equal(r.member.last_check, "2026-06-26");
  assert.equal(r.member.last_result, "clean");
  assert.equal(r.member.longest_streak, 6);
  assert.equal(r.member.quit_date, "2026-06-20"); // unchanged
});

test("applyCheckin smoked: banks longest, resets streak to tomorrow, increments resets", () => {
  const m = { ...newMember({ name: "דני", e164: "", quitDate: "2026-06-20", nowIso: "x" }), last_check: "2026-06-25", last_result: "clean" };
  const r = applyCheckin(m, "smoked", "2026-06-26");
  assert.equal(r.wasRelapse, true);
  assert.equal(r.cleanDays, 0);
  assert.equal(r.member.total_resets, 1);
  assert.equal(r.member.quit_date, "2026-06-27"); // fresh start tomorrow
  assert.equal(r.member.longest_streak, 6); // 2026-06-20 → 2026-06-26 = 6 banked
  assert.equal(r.member.last_result, "smoked");
  // and clean_days recomputes to 0 the next day, 1 the day after
  assert.equal(computeCleanDays(r.member, "2026-06-27"), 0);
  assert.equal(computeCleanDays(r.member, "2026-06-28"), 1);
});

test("milestones cross exactly once at thresholds", () => {
  assert.deepEqual(crossedMilestones(0, 1).map((m) => m.days), [1]);
  assert.deepEqual(crossedMilestones(6, 7).map((m) => m.days), [7]);
  assert.deepEqual(crossedMilestones(0, 3).map((m) => m.days), [1, 2, 3]);
  assert.deepEqual(crossedMilestones(7, 7), []); // already crossed
  assert.deepEqual(crossedMilestones(364, 365).map((m) => m.days), [365]);
  assert.ok(MILESTONES.every((m) => typeof m.body === "string" && m.body.length));
});

test("applyCheckin clean reports newly-crossed milestone", () => {
  // member quit 2026-06-25, last checked 2026-06-25 (0 days), now 2026-06-26 → crosses day 1
  const m = { ...newMember({ name: "x", e164: "", quitDate: "2026-06-25", nowIso: "x" }), last_check: "2026-06-25", last_result: "clean" };
  const r = applyCheckin(m, "clean", "2026-06-26");
  assert.deepEqual(r.crossed.map((c) => c.days), [1]);
});

test("leaderboard ranks by clean_days then longest then fewer resets", () => {
  const members = [
    newMember({ name: "אלף", e164: "", quitDate: "2026-06-25", nowIso: "x" }), // 1 day
    newMember({ name: "בית", e164: "", quitDate: "2026-06-01", nowIso: "x" }), // 25 days
    { ...newMember({ name: "גימל", e164: "", quitDate: "2026-06-01", nowIso: "x" }), longest_streak: 99 }, // 25 days, longer best
  ];
  const lb = leaderboard(members, "2026-06-26");
  assert.equal(lb[0].member_name, "גימל"); // ties on 25 days, but longest_streak wins
  assert.equal(lb[1].member_name, "בית");
  assert.equal(lb[2].member_name, "אלף");
  assert.deepEqual(lb.map((m) => m.rank), [1, 2, 3]);
});

test("pendingMembers = those not checked in on date", () => {
  const members = [
    { ...newMember({ name: "a", e164: "", quitDate: "2026-06-01", nowIso: "x" }), last_check: "2026-06-26" },
    { ...newMember({ name: "b", e164: "", quitDate: "2026-06-01", nowIso: "x" }), last_check: "2026-06-25" },
    newMember({ name: "c", e164: "", quitDate: "2026-06-01", nowIso: "x" }), // never
  ];
  const p = pendingMembers(members, "2026-06-26").map((m) => m.member_name);
  assert.deepEqual(p.sort(), ["b", "c"]);
});

test("aggregateStats", () => {
  const members = [
    newMember({ name: "a", e164: "", quitDate: "2026-06-20", nowIso: "x" }), // 6
    { ...newMember({ name: "b", e164: "", quitDate: "2026-06-24", nowIso: "x" }), longest_streak: 40, total_resets: 2 }, // 2
  ];
  const s = aggregateStats(members, "2026-06-26");
  assert.equal(s.members, 2);
  assert.equal(s.total_clean_days, 8);
  assert.equal(s.longest_active_streak, 6);
  assert.equal(s.longest_ever, 40);
  assert.equal(s.total_resets, 2);
});

test("resolveMember by name / id / e164 / partial", () => {
  const members = [newMember({ name: "דני כהן", e164: "972501234567", quitDate: "2026-06-20", nowIso: "x" })];
  assert.ok(resolveMember(members, "דני כהן"));
  assert.ok(resolveMember(members, members[0].id));
  assert.ok(resolveMember(members, "0501234567"));
  assert.ok(resolveMember(members, "דני")); // partial
  assert.equal(resolveMember(members, "משה"), null);
});

test("slugify keeps Hebrew, drops junk", () => {
  assert.equal(slugify("דני כהן"), "דני-כהן");
  assert.equal(slugify("  !!!  "), "member");
});
