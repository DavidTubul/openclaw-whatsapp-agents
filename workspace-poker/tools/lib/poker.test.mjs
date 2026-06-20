import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePlayer, currentSession, sessionResults, sessionBalanced,
  settleUp, lifetimeStats, newSession, ensureEntry, setRsvp, bareE164, normName,
} from "./poker.mjs";

const players = [
  { id: "david", name: "דוד", e164: ["972500000000"], aliases: ["david", "דייב"] },
  { id: "danny", name: "דני כהן", e164: ["972500000001"], aliases: ["דני"] },
  { id: "yossi", name: "אורח", e164: [], aliases: [] },
];

test("normName / bareE164", () => {
  assert.equal(normName("  David  "), "david");
  assert.equal(bareE164("972500000000@s.whatsapp.net"), "972500000000");
  assert.equal(bareE164("+972-50-000-0000"), "972500000000");
});

test("resolvePlayer: id, name, alias, e164, substring", () => {
  assert.equal(resolvePlayer(players, "david").id, "david");
  assert.equal(resolvePlayer(players, "דוד").id, "david");
  assert.equal(resolvePlayer(players, "דייב").id, "david");
  assert.equal(resolvePlayer(players, "972500000000@g.us").id, "david");
  assert.equal(resolvePlayer(players, "דני").id, "danny");
  assert.equal(resolvePlayer(players, "דני כהן").id, "danny");
  assert.equal(resolvePlayer(players, "מישהו")?.id ?? null, null);
  assert.equal(resolvePlayer(players, ""), null);
});

test("currentSession: newest non-closed", () => {
  const sessions = [
    { id: "a", date: "2026-06-01", status: "closed", created: "2026-06-01" },
    { id: "b", date: "2026-06-10", status: "planned", created: "2026-06-10" },
    { id: "c", date: "2026-06-05", status: "active", created: "2026-06-05" },
  ];
  assert.equal(currentSession(sessions).id, "b");
  assert.equal(currentSession(sessions.filter((s) => s.status === "closed")), null);
});

test("sessionResults: net = cashout - buyins, sorted desc", () => {
  const s = {
    entries: {
      david: { buyins: [50, 50], cashout: 220 }, // +120
      danny: { buyins: [100], cashout: 20 },     // -80
      yossi: { buyins: [50], cashout: null },    // -50 (not cashed)
    },
  };
  const rows = sessionResults(s, players);
  assert.deepEqual(rows.map((r) => r.player), ["david", "yossi", "danny"]);
  const david = rows.find((r) => r.player === "david");
  assert.equal(david.buyin, 100);
  assert.equal(david.net, 120);
  const yossi = rows.find((r) => r.player === "yossi");
  assert.equal(yossi.cashedOut, false);
  assert.equal(yossi.cashout, null);
  assert.equal(yossi.net, -50);
});

test("sessionBalanced: detects unbalanced + not-all-cashed", () => {
  const balanced = { entries: { a: { buyins: [100], cashout: 60 }, b: { buyins: [50], cashout: 90 } } };
  assert.equal(sessionBalanced(balanced).balanced, true);
  const off = { entries: { a: { buyins: [100], cashout: 60 }, b: { buyins: [50], cashout: 80 } } };
  assert.equal(sessionBalanced(off).balanced, false);
  assert.equal(sessionBalanced(off).diff, -10);
  const open = { entries: { a: { buyins: [100], cashout: null } } };
  assert.equal(sessionBalanced(open).allCashed, false);
  assert.equal(sessionBalanced(open).balanced, false);
});

test("settleUp: minimal payments, balances out", () => {
  // david +120, danny -80, yossi -40
  const nets = [{ player: "david", net: 120 }, { player: "danny", net: -80 }, { player: "yossi", net: -40 }];
  const pays = settleUp(nets);
  // both debtors pay david; total received = 120
  const received = pays.filter((p) => p.to === "david").reduce((a, p) => a + p.amount, 0);
  assert.equal(received, 120);
  assert.ok(pays.every((p) => p.amount > 0));
  // each debtor pays exactly their debt
  assert.equal(pays.find((p) => p.from === "danny").amount, 80);
  assert.equal(pays.find((p) => p.from === "yossi").amount, 40);
});

test("settleUp: two winners two losers", () => {
  const nets = [
    { player: "a", net: 100 }, { player: "b", net: 50 },
    { player: "c", net: -90 }, { player: "d", net: -60 },
  ];
  const pays = settleUp(nets);
  const sumOut = pays.reduce((a, p) => a + p.amount, 0);
  assert.equal(sumOut, 150);
  // conservation: each player's net is satisfied
  const bal = {};
  for (const p of pays) { bal[p.from] = (bal[p.from] || 0) - p.amount; bal[p.to] = (bal[p.to] || 0) + p.amount; }
  assert.equal(bal.a, 100); assert.equal(bal.b, 50);
  assert.equal(bal.c, -90); assert.equal(bal.d, -60);
});

test("settleUp: nobody owes → empty", () => {
  assert.deepEqual(settleUp([{ player: "a", net: 0 }, { player: "b", net: 0 }]), []);
});

test("lifetimeStats: only closed sessions, leaderboard order", () => {
  const sessions = [
    { id: "s1", date: "2026-06-01", status: "closed", entries: {
      david: { buyins: [100], cashout: 250 }, // +150
      danny: { buyins: [100], cashout: 0 },   // -100
      yossi: { buyins: [50], cashout: 0 },    // -50
    } },
    { id: "s2", date: "2026-06-08", status: "closed", entries: {
      david: { buyins: [100], cashout: 50 },  // -50
      danny: { buyins: [100], cashout: 150 }, // +50
    } },
    { id: "s3", date: "2026-06-12", status: "active", entries: {
      david: { buyins: [100], cashout: null }, // excluded (open)
    } },
  ];
  const lb = lifetimeStats(sessions, players);
  const david = lb.find((p) => p.player === "david");
  assert.equal(david.net, 100);       // +150 -50
  assert.equal(david.sessions, 2);    // s3 excluded
  assert.equal(david.biggestWin, 150);
  assert.equal(david.biggestLoss, -50);
  assert.equal(david.wins, 1);
  assert.equal(david.losses, 1);
  // leaderboard sorted by net desc
  assert.deepEqual(lb.map((p) => p.player), ["david", "danny", "yossi"]);
  assert.equal(lb.find((p) => p.player === "danny").net, -50);
});

test("newSession / ensureEntry / setRsvp", () => {
  const s = newSession({ id: "2026-06-13", date: "2026-06-13", location: "אצל דני" });
  assert.equal(s.status, "planned");
  const e = ensureEntry(s, "david");
  e.buyins.push(50);
  assert.equal(s.entries.david.buyins[0], 50);
  setRsvp(s, "david", "in");
  setRsvp(s, "danny", "maybe");
  assert.deepEqual(s.rsvp.in, ["david"]);
  assert.deepEqual(s.rsvp.maybe, ["danny"]);
  setRsvp(s, "david", "out"); // moves david in→out
  assert.deepEqual(s.rsvp.in, []);
  assert.deepEqual(s.rsvp.out, ["david"]);
});
