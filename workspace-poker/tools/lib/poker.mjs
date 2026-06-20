// Pure functions for the poker home-game ledger.
// No file IO here — everything is a pure transformation so it can be unit-tested.
// Money is plain numbers (shekels, ₪). Sessions track buy-ins + cash-outs per player.

/** Normalize a free-text name/alias for matching (lowercase, trim, strip niqqud-ish noise). */
export function normName(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strip a WhatsApp JID/suffix and non-digits → bare e164 (digits only). */
export function bareE164(s) {
  return (s ?? "").toString().replace(/@.*/, "").replace(/\D/g, "");
}

/**
 * Resolve a player from a free-text query (name, id, alias, or e164).
 * Returns the player object or null. Matching is case/space-insensitive and
 * also matches a query that is a substring of a name/alias (so "דני" finds "דני כהן").
 */
export function resolvePlayer(players, query) {
  if (!query) return null;
  const q = normName(query);
  const qDigits = bareE164(query);
  // 1. exact id / name / alias
  for (const p of players) {
    if (normName(p.id) === q) return p;
    if (normName(p.name) === q) return p;
    if ((p.aliases || []).some((a) => normName(a) === q)) return p;
  }
  // 2. e164 match
  if (qDigits.length >= 6) {
    for (const p of players) {
      if ((p.e164 || []).some((e) => bareE164(e) === qDigits)) return p;
    }
  }
  // 3. substring on name/alias (q inside, or name inside q)
  for (const p of players) {
    const hay = [p.name, p.id, ...(p.aliases || [])].map(normName);
    if (hay.some((h) => h && (h.includes(q) || q.includes(h)))) return p;
  }
  return null;
}

/** The "current" session = newest session whose status is not "closed". null if none. */
export function currentSession(sessions) {
  const open = sessions.filter((s) => s.status !== "closed");
  if (!open.length) return null;
  // newest by date then by created timestamp
  return open.slice().sort((a, b) => cmpStr(b.date, a.date) || cmpStr(b.created, a.created))[0];
}

function cmpStr(a, b) {
  a = a || ""; b = b || "";
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Find a session by id. null if missing. */
export function findSession(sessions, id) {
  return sessions.find((s) => s.id === id) || null;
}

/** Sum of buy-ins for a player entry. */
export function totalBuyin(entry) {
  return (entry?.buyins || []).reduce((a, b) => a + Number(b || 0), 0);
}

/**
 * Per-player results for ONE session.
 * net = cashout - sum(buyins). cashout null = hasn't cashed out yet (net counts -buyin so far).
 * Returns [{ player, name, buyin, cashout, net, cashedOut }] sorted by net desc.
 */
export function sessionResults(session, players = []) {
  const entries = session?.entries || {};
  const rows = Object.keys(entries).map((pid) => {
    const e = entries[pid];
    const buyin = totalBuyin(e);
    const cashedOut = e.cashout !== null && e.cashout !== undefined;
    const cashout = cashedOut ? Number(e.cashout) : 0;
    const net = cashout - buyin;
    const p = players.find((x) => x.id === pid);
    return { player: pid, name: p?.name || pid, buyin, cashout: cashedOut ? cashout : null, net, cashedOut };
  });
  return rows.sort((a, b) => b.net - a.net);
}

/** Does a session's chips balance? (sum of cashouts === sum of buyins, within epsilon). */
export function sessionBalanced(session) {
  const entries = session?.entries || {};
  let buyins = 0, cashouts = 0, allCashed = true;
  for (const pid of Object.keys(entries)) {
    const e = entries[pid];
    buyins += totalBuyin(e);
    if (e.cashout === null || e.cashout === undefined) allCashed = false;
    else cashouts += Number(e.cashout);
  }
  return { buyins, cashouts, diff: cashouts - buyins, allCashed, balanced: allCashed && Math.abs(cashouts - buyins) < 0.005 };
}

/**
 * Settle-up: given per-player nets (positive = is owed money, negative = owes),
 * produce a minimal-ish list of payments { from, to, amount }.
 * Greedy largest-debtor → largest-creditor. Amounts rounded to 2 decimals.
 * Input: [{ player, net }]. Output payments reference player ids.
 */
export function settleUp(nets) {
  const debtors = nets.filter((n) => n.net < -0.005).map((n) => ({ id: n.player, amt: -n.net }));
  const creditors = nets.filter((n) => n.net > 0.005).map((n) => ({ id: n.player, amt: n.net }));
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const payments = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    payments.push({ from: debtors[i].id, to: creditors[j].id, amount: round2(pay) });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }
  return payments;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Lifetime stats across CLOSED sessions only (open sessions are in-progress and excluded).
 * Returns [{ player, name, sessions, net, biggestWin, biggestLoss, totalBuyin, wins, losses }]
 * sorted by net desc — the leaderboard.
 */
export function lifetimeStats(sessions, players = []) {
  const closed = sessions.filter((s) => s.status === "closed");
  const acc = {};
  for (const s of closed) {
    for (const row of sessionResults(s, players)) {
      const a = (acc[row.player] ||= {
        player: row.player, name: row.name, sessions: 0, net: 0,
        biggestWin: 0, biggestLoss: 0, totalBuyin: 0, wins: 0, losses: 0,
      });
      a.sessions += 1;
      a.net += row.net;
      a.totalBuyin += row.buyin;
      if (row.net > a.biggestWin) a.biggestWin = row.net;
      if (row.net < a.biggestLoss) a.biggestLoss = row.net;
      if (row.net > 0.005) a.wins += 1;
      else if (row.net < -0.005) a.losses += 1;
    }
  }
  return Object.values(acc)
    .map((a) => ({ ...a, net: round2(a.net), totalBuyin: round2(a.totalBuyin) }))
    // leaderboard: net desc, then more sessions played, then name — deterministic on ties.
    .sort((a, b) => b.net - a.net || b.sessions - a.sessions || cmpStr(a.name, b.name));
}

/** Default empty session object for a given id/date. */
export function newSession({ id, date, location = "", time = "", created }) {
  return {
    id, date, location, time,
    status: "planned",
    rsvp: { in: [], out: [], maybe: [] },
    entries: {},
    created: created || date,
    updated: created || date,
  };
}

/** Ensure an entry exists for a player on a session (mutates + returns it). */
export function ensureEntry(session, playerId) {
  session.entries ||= {};
  session.entries[playerId] ||= { buyins: [], cashout: null };
  return session.entries[playerId];
}

/** Set RSVP status for a player on a session, removing from the other buckets. Mutates. */
export function setRsvp(session, playerId, status) {
  session.rsvp ||= { in: [], out: [], maybe: [] };
  for (const k of ["in", "out", "maybe"]) {
    session.rsvp[k] = (session.rsvp[k] || []).filter((x) => x !== playerId);
  }
  if (["in", "out", "maybe"].includes(status)) session.rsvp[status].push(playerId);
  return session.rsvp;
}
