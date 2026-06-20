#!/usr/bin/env node
// poker.mjs — the deterministic core of דילר 🎰, the home-game poker assistant.
// File-backed ledger: players, sessions, RSVP, buy-ins, cash-outs, settle-up, stats.
// All output is JSON on stdout so the LLM can consume it. Errors → {ok:false,error}.
//
// Data files (under workspace-poker/data/, override dir with POKER_DATA_DIR):
//   players.json   { players: [ {id,name,e164:[],aliases:[]} ] }
//   sessions.json  { sessions: [ <session> ] }
//
// Usage (run from workspace-poker/):
//   node tools/poker.mjs players
//   node tools/poker.mjs add-player <name> [e164]
//   node tools/poker.mjs session new [--date YYYY-MM-DD] [--location "..."] [--time "21:00"]
//   node tools/poker.mjs session list | show [id] | current
//   node tools/poker.mjs session start [id]      # planned -> active
//   node tools/poker.mjs rsvp <player> <in|out|maybe> [--session id]
//   node tools/poker.mjs buyin <player> <amount> [--session id]
//   node tools/poker.mjs cashout <player> <amount> [--session id]
//   node tools/poker.mjs close [id]              # active -> closed (validates balance)
//   node tools/poker.mjs reopen [id]
//   node tools/poker.mjs settle [id]             # who pays whom for a session
//   node tools/poker.mjs results [id]            # per-player net for a session
//   node tools/poker.mjs leaderboard             # lifetime net ranking
//   node tools/poker.mjs balance [player]        # lifetime net (all or one player)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePlayer, currentSession, findSession, sessionResults, sessionBalanced,
  settleUp, lifetimeStats, newSession, ensureEntry, setRsvp, normName,
} from "./lib/poker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.POKER_DATA_DIR || resolve(HERE, "..", "data");
const PLAYERS_FILE = resolve(DATA_DIR, "players.json");
const SESSIONS_FILE = resolve(DATA_DIR, "sessions.json");

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { out({ ok: false, error: msg }); process.exit(1); }

async function loadJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}
async function saveJSON(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n");
}
const loadPlayers = () => loadJSON(PLAYERS_FILE, { players: [] });
const loadSessions = () => loadJSON(SESSIONS_FILE, { sessions: [] });

// --- arg parsing: positional args + --flag value pairs ---
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

function today() {
  // Asia/Jerusalem date — avoid UTC drift for evening games.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
}
function nowIso() { return new Date().toISOString(); }

function slugId(name) {
  return normName(name).replace(/[^a-z0-9א-ת]+/g, "-").replace(/^-+|-+$/g, "") || "p" + Date.now();
}

/** Resolve a session by explicit id/flag, else the current open session. */
function pickSession(db, id) {
  if (id) {
    const s = findSession(db.sessions, id);
    if (!s) fail(`session not found: ${id}`);
    return s;
  }
  const s = currentSession(db.sessions);
  if (!s) fail("no open session — create one with: session new");
  return s;
}

function requirePlayer(players, query) {
  const p = resolvePlayer(players, query);
  if (!p) fail(`unknown player: "${query}" — add with: add-player "${query}"`);
  return p;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { pos, flags } = parseArgs(rest);

  switch (cmd) {
    /* ---- players ---- */
    case "players": {
      const { players } = await loadPlayers();
      return out({ ok: true, players });
    }
    case "add-player": {
      const name = pos[0];
      if (!name) fail("usage: add-player <name> [e164]");
      const db = await loadPlayers();
      const existing = resolvePlayer(db.players, name);
      if (existing) return out({ ok: true, player: existing, note: "already exists" });
      let id = slugId(name);
      while (db.players.some((p) => p.id === id)) id += "1";
      const e164 = pos[1] ? [pos[1].replace(/\D/g, "")] : [];
      const player = { id, name, e164, aliases: [] };
      db.players.push(player);
      await saveJSON(PLAYERS_FILE, db);
      return out({ ok: true, player });
    }
    case "find-player": {
      const { players } = await loadPlayers();
      return out({ ok: true, player: resolvePlayer(players, pos[0]) });
    }

    /* ---- sessions ---- */
    case "session": {
      const sub = pos[0];
      const db = await loadSessions();
      if (sub === "new") {
        const date = flags.date || today();
        let id = date;
        let n = 1;
        while (db.sessions.some((s) => s.id === id)) id = `${date}-${++n}`;
        const s = newSession({ id, date, location: flags.location || "", time: flags.time || "", created: nowIso() });
        db.sessions.push(s);
        await saveJSON(SESSIONS_FILE, db);
        return out({ ok: true, session: s });
      }
      if (sub === "list") {
        return out({ ok: true, sessions: db.sessions.map((s) => ({
          id: s.id, date: s.date, status: s.status, location: s.location, time: s.time,
          players: Object.keys(s.entries || {}).length,
          rsvp_in: (s.rsvp?.in || []).length,
        })) });
      }
      if (sub === "current") {
        const s = currentSession(db.sessions);
        return out({ ok: true, session: s });
      }
      if (sub === "show") {
        const s = pickSession(db, pos[1] || flags.session);
        const { players } = await loadPlayers();
        return out({ ok: true, session: s, results: sessionResults(s, players), balance: sessionBalanced(s) });
      }
      if (sub === "start") {
        const s = pickSession(db, pos[1] || flags.session);
        s.status = "active"; s.updated = nowIso();
        await saveJSON(SESSIONS_FILE, db);
        return out({ ok: true, session: s });
      }
      fail(`unknown session subcommand: ${sub}`);
      break;
    }

    /* ---- RSVP ---- */
    case "rsvp": {
      const [who, status] = pos;
      if (!who || !["in", "out", "maybe"].includes(status)) fail("usage: rsvp <player> <in|out|maybe>");
      const players = (await loadPlayers()).players;
      const p = requirePlayer(players, who);
      const db = await loadSessions();
      const s = pickSession(db, flags.session);
      setRsvp(s, p.id, status); s.updated = nowIso();
      await saveJSON(SESSIONS_FILE, db);
      return out({ ok: true, session: s.id, player: p.id, rsvp: s.rsvp });
    }

    /* ---- money ---- */
    case "buyin":
    case "cashout": {
      const who = pos[0];
      const amount = Number(pos[1]);
      if (!who || !Number.isFinite(amount)) fail(`usage: ${cmd} <player> <amount>`);
      const players = (await loadPlayers()).players;
      const p = requirePlayer(players, who);
      const db = await loadSessions();
      const s = pickSession(db, flags.session);
      if (s.status === "closed") fail(`session ${s.id} is closed — reopen it first`);
      const e = ensureEntry(s, p.id);
      if (cmd === "buyin") e.buyins.push(amount);
      else e.cashout = amount;
      if (s.status === "planned") s.status = "active";
      s.updated = nowIso();
      await saveJSON(SESSIONS_FILE, db);
      return out({ ok: true, session: s.id, player: p.id, entry: e, results: sessionResults(s, players) });
    }

    /* ---- lifecycle ---- */
    case "close": {
      const db = await loadSessions();
      const s = pickSession(db, pos[0] || flags.session);
      const bal = sessionBalanced(s);
      if (!flags.force && !bal.balanced) {
        return out({ ok: false, error: "session not balanced", balance: bal,
          hint: bal.allCashed ? "cashouts ≠ buy-ins; fix amounts or pass --force"
                              : "not everyone cashed out yet; add cashouts or pass --force" });
      }
      s.status = "closed"; s.updated = nowIso();
      await saveJSON(SESSIONS_FILE, db);
      const { players } = await loadPlayers();
      const results = sessionResults(s, players);
      return out({ ok: true, session: s.id, status: "closed", results, settle: namedSettle(results) });
    }
    case "reopen": {
      const db = await loadSessions();
      const s = pickSession(db, pos[0] || flags.session);
      s.status = "active"; s.updated = nowIso();
      await saveJSON(SESSIONS_FILE, db);
      return out({ ok: true, session: s.id, status: "active" });
    }

    /* ---- reporting ---- */
    case "results": {
      const db = await loadSessions();
      const s = pickSession(db, pos[0] || flags.session);
      const { players } = await loadPlayers();
      return out({ ok: true, session: s.id, status: s.status, results: sessionResults(s, players), balance: sessionBalanced(s) });
    }
    case "settle": {
      const db = await loadSessions();
      const s = pickSession(db, pos[0] || flags.session);
      const { players } = await loadPlayers();
      const results = sessionResults(s, players);
      return out({ ok: true, session: s.id, settle: namedSettle(results), results });
    }
    case "leaderboard":
    case "stats": {
      const db = await loadSessions();
      const { players } = await loadPlayers();
      return out({ ok: true, leaderboard: lifetimeStats(db.sessions, players) });
    }
    case "balance": {
      const db = await loadSessions();
      const { players } = await loadPlayers();
      const lb = lifetimeStats(db.sessions, players);
      if (pos[0]) {
        const p = requirePlayer(players, pos[0]);
        const row = lb.find((x) => x.player === p.id) || { player: p.id, name: p.name, net: 0, sessions: 0 };
        return out({ ok: true, balance: row });
      }
      return out({ ok: true, balances: lb });
    }

    default:
      fail(`unknown command: ${cmd || "(none)"} — see header of tools/poker.mjs for usage`);
  }
}

/** Turn session results into named settle-up payments (resolves player ids → names). */
function namedSettle(results) {
  const nameOf = Object.fromEntries(results.map((r) => [r.player, r.name]));
  return settleUp(results.map((r) => ({ player: r.player, net: r.net })))
    .map((p) => ({ from: nameOf[p.from] || p.from, to: nameOf[p.to] || p.to, amount: p.amount }));
}

main().catch((e) => fail(e?.message || String(e)));
