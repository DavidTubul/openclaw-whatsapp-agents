import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { postWebhook, pushToSheet, requestWebhook } from './sheet-webhook.mjs';

function serve(handler) {
  return new Promise((resolveP) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolveP({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

test('postWebhook: JSON response parsed, ok/status surfaced', async () => {
  const { srv, url } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoed: JSON.parse(body).action }));
    });
  });
  try {
    const r = await postWebhook(url, { action: 'append', row: { a: 1 } });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.response.echoed, 'append');
  } finally { srv.close(); }
});

test('postWebhook: non-JSON (Apps Script HTML error page) → raw excerpt, no throw', async () => {
  const { srv, url } = await serve((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<html>Script error</html>');
  });
  try {
    const r = await postWebhook(url, { action: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
    assert.match(r.response.raw, /Script error/);
  } finally { srv.close(); }
});

test('postWebhook: hung server → timeout error, never hangs the turn', async () => {
  const { srv, url } = await serve(() => { /* never respond */ });
  try {
    const r = await postWebhook(url, { action: 'x' }, { timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timeout after 200ms/);
  } finally { srv.close(); }
});

test('postWebhook: connection refused → error object, no throw', async () => {
  const r = await postWebhook('http://127.0.0.1:1/', { action: 'x' }, { timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('pushToSheet: disabled or missing config → skipped without any network call', async () => {
  assert.deepEqual(await pushToSheet(undefined, 'append', {}), { skipped: 'sheet disabled' });
  assert.deepEqual(await pushToSheet({ enabled: false, webhook_url: 'http://x/' }, 'append', {}), { skipped: 'sheet disabled' });
  assert.deepEqual(await pushToSheet({ enabled: true }, 'append', {}), { skipped: 'sheet disabled' });
});

// ---- retry capability (injected transport — no live network) --------------------------------

// A fake fetch that plays back a scripted list of responses/errors, recording each call's opts.
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step.throw) { const e = new Error(step.throw.message); if (step.throw.name) e.name = step.throw.name; throw e; }
    return { ok: step.status < 400, status: step.status, text: async () => step.text ?? '' };
  };
  return { impl, calls };
}
const noSleep = () => Promise.resolve();

test('requestWebhook: retry OFF by default — a 5xx returns immediately (one call)', async () => {
  const f = fakeFetch([{ status: 500, text: 'err' }, { status: 200, text: 'ok' }]);
  const r = await requestWebhook('http://x/', { a: 1 }, { fetchImpl: f.impl });
  assert.equal(r.status, 500);
  assert.equal(f.calls.length, 1);
});

test('requestWebhook: retry ON — 5xx twice then 200 succeeds (3 calls, exp backoff)', async () => {
  const f = fakeFetch([{ status: 503, text: 'a' }, { status: 502, text: 'b' }, { status: 200, text: '{"ok":true}' }]);
  const r = await requestWebhook('http://x/', { a: 1 }, { retry: true, fetchImpl: f.impl, sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"ok":true}');
  assert.equal(f.calls.length, 3);
});

test('requestWebhook: retry ON — 5xx on every attempt returns the final response, not an error', async () => {
  const f = fakeFetch([{ status: 500, text: 'still down' }]);
  const r = await requestWebhook('http://x/', { a: 1 }, { retry: { tries: 3, baseMs: 1 }, fetchImpl: f.impl, sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.text, 'still down');
  assert.equal(f.calls.length, 3);
});

test('requestWebhook: retry ON — transient network error then success', async () => {
  const f = fakeFetch([{ throw: { message: 'ECONNRESET' } }, { status: 200, text: 'ok' }]);
  const r = await requestWebhook('http://x/', { a: 1 }, { retry: true, fetchImpl: f.impl, sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 2);
});

test('requestWebhook: timeout is TERMINAL — never retried even with retry ON', async () => {
  const f = fakeFetch([{ throw: { name: 'AbortError', message: 'aborted' } }, { status: 200, text: 'ok' }]);
  const r = await requestWebhook('http://x/', { a: 1 }, { retry: true, fetchImpl: f.impl, sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.timeout, true);
  assert.equal(f.calls.length, 1); // not retried
});

test('requestWebhook: GET when body is undefined, POST JSON otherwise', async () => {
  const g = fakeFetch([{ status: 200, text: 'ok' }]);
  await requestWebhook('http://x/', undefined, { fetchImpl: g.impl });
  assert.equal(g.calls[0].opts.method, undefined); // GET (no method forced)
  assert.equal(g.calls[0].opts.body, undefined);

  const p = fakeFetch([{ status: 200, text: 'ok' }]);
  await requestWebhook('http://x/', { action: 'append' }, { fetchImpl: p.impl });
  assert.equal(p.calls[0].opts.method, 'POST');
  assert.equal(p.calls[0].opts.body, JSON.stringify({ action: 'append' }));
});

test('postWebhook: retry option flows through and parses the eventual JSON', async () => {
  const f = fakeFetch([{ status: 500, text: 'flake' }, { status: 200, text: '{"ok":true,"n":2}' }]);
  const r = await postWebhook('http://x/', { action: 'append' }, { retry: true, fetchImpl: f.impl, sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(r.response, { ok: true, n: 2 });
  assert.equal(f.calls.length, 2);
});
