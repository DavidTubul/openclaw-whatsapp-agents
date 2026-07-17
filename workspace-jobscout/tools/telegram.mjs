#!/usr/bin/env node
// Telegram job-source tool (gramjs / MTProto).
//   node telegram.mjs login   -> interactive one-time auth, prints a StringSession
//   node telegram.mjs fetch    -> pulls new channel messages as job candidates (JSON)
// Reads TELEGRAM_API_ID, TELEGRAM_API_HASH, and (for fetch) TELEGRAM_SESSION from env.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { evaluateLocation } from './lib/location-filter.mjs';
import { personIdFromArgv, failJson as fail, requireEnv, readJsonSafe } from './lib/cli.mjs';
import { writeJsonAtomic } from '../../shared/lib/fs-atomic.mjs';
import { loadPersonContext } from './lib/person-config.mjs';
import { appendDrops } from './lib/droplog.mjs';
import { todayInTz } from '../../shared/lib/time.mjs';

function getApiCreds() {
  const { TELEGRAM_API_ID, TELEGRAM_API_HASH } = requireEnv(['TELEGRAM_API_ID', 'TELEGRAM_API_HASH']);
  return { apiId: Number(TELEGRAM_API_ID), apiHash: TELEGRAM_API_HASH };
}

const loadState = (statePath) => readJsonSafe(statePath, {}) || {};
const saveState = (statePath, state) => writeJsonAtomic(statePath, state, { pretty: 2 }); // pretty-printed

async function login() {
  const { apiId, apiHash } = getApiCreds();
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  const rl = readline.createInterface({ input, output });
  await client.start({
    phoneNumber: async () => (await rl.question('Phone (+972...): ')).trim(),
    password: async () => (await rl.question('2FA password (blank if none): ')).trim(),
    phoneCode: async () => (await rl.question('Code from Telegram: ')).trim(),
    onError: (err) => console.error('login error:', err?.message || err),
  });
  rl.close();
  await client.disconnect();
  console.error('\n--- Save this as TELEGRAM_SESSION in secrets.conf ---');
  console.log(client.session.save());
}

async function fetch() {
  // gramjs logs (version banner, connection info) go to console.log → stdout.
  // Redirect them to stderr so stdout carries ONLY our final JSON (the pipeline parses stdout).
  console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

  const { apiId, apiHash } = getApiCreds();
  const sessionStr = process.env.TELEGRAM_SESSION;
  if (!sessionStr) fail('TELEGRAM_SESSION not set (run `node telegram.mjs login` first)');

  // --no-persist: read-only test run — don't advance the per-channel cursor (skip saveState)
  // and don't write the drop log. minId is still used as-is, so a test run never starves the
  // next morning's real scout by advancing the last_seen_id past unprocessed messages.
  const noPersist = process.argv.includes('--no-persist');

  const personId = personIdFromArgv();
  const { person, locFilter } = loadPersonContext(personId, { locationFilter: true });
  const tg = person.telegram || {};
  const channels = Array.isArray(tg.channels) ? tg.channels : [];
  if (channels.length === 0) fail('No telegram.channels configured for this person');
  const maxMessages = Number(tg.max_messages_per_run) || 100;
  const lookbackHours = Number(tg.lookback_hours) || 48;
  const cutoffSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const STATE_PATH = person.paths.telegramState;

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    fail('Telegram session invalid or expired (AUTH) — re-run login');
  }

  const state = loadState(STATE_PATH);
  const candidates = [];
  const drops = [];                                   // audit trail → data/drops.jsonl
  const today = todayInTz(); // tz-aware (Asia/Jerusalem), not naive UTC

  for (const channel of channels) {
    const lastSeen = Number(state?.[channel]?.last_seen_id) || 0;
    let maxId = lastSeen;
    let messages = [];
    try {
      messages = await client.getMessages(channel, { limit: maxMessages, minId: lastSeen });
    } catch (e) {
      process.stderr.write(`[telegram] channel "${channel}" failed: ${e?.message}\n`);
      continue;
    }
    for (const m of messages) {
      const id = m?.id;
      const text = (m?.message || '').trim();
      const dateSec = Number(m?.date) || 0;
      if (!id || !text) continue;
      if (id > maxId) maxId = id;
      if (dateSec && dateSec < cutoffSec) continue;
      const { keep, location } = evaluateLocation(text, locFilter);
      if (!keep) {
        // Location-drop audit: record the permalink + first 120 chars of the post so a future
        // "a job was in the channel but never reached me" is answerable (title = post text, capped
        // in droplog). Reason is always 'location' — the only filter Telegram fetch applies here.
        drops.push({ date: today, source: `telegram:${channel}`, id: id, url: `https://t.me/${channel}/${id}`, title: text, company: '', location: '', reason: 'location' });
        continue;
      }
      candidates.push({
        source: `telegram:${channel}`,
        title: '',
        company: '',
        location,
        url: `https://t.me/${channel}/${id}`,
        snippet: text,
        score: 0,
        msg_id: id,
        date: dateSec ? new Date(dateSec * 1000).toISOString() : '',
      });
    }
    state[channel] = { last_seen_id: maxId, updated_at: new Date().toISOString() };
  }

  await client.disconnect();
  // --no-persist: skip the cursor write (don't advance last_seen_id) AND the drop log, so a test
  // run mutates nothing. A normal run persists both.
  if (!noPersist) {
    saveState(STATE_PATH, state);
    if (drops.length) {
      try { appendDrops(person.paths.dropsLog, drops); }
      catch (e) { process.stderr.write(`[telegram] drop-log write failed: ${e.message}\n`); }
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, count: candidates.length, candidates, persisted: !noPersist }) + '\n');
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'login') return login();
  if (cmd === 'fetch') return fetch();
  fail(`Unknown command "${cmd}". Use: login | fetch`);
}

main().catch((e) => fail(e));
