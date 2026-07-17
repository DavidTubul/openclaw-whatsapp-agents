// shared/lib/sheet-webhook.mjs — ONE Google-Sheets Apps-Script webhook client for every bot.
//
// Before this existed the same `pushToSheet` was hand-copied into zorro/pitzi (byte-identical,
// and BOTH without a timeout — a hung Apps Script call stalled a whole agent turn), with a third
// divergent copy in pitzi's sheet-sync and a fourth in jobscout. One client, one timeout policy.
//
// Contract (matches the Apps Script side): POST JSON, follow redirects (script.google.com always
// 302s to googleusercontent), tolerate non-JSON responses (Apps Script error pages are HTML).
//
// Layering:
//   requestWebhook — low-level fetch: timeout + OPTIONAL retry, returns the raw response text.
//   postWebhook    — parses requestWebhook's text into JSON (the shape zorro/pitzi consume).
//   pushToSheet    — enabled-gated mirror wrapper over postWebhook.

/** Normalize the `retry` option → null (off) or { tries, baseMs }. */
function normRetry(retry) {
  if (!retry) return null;
  if (retry === true) return { tries: 3, baseMs: 600 };
  return { tries: Number(retry.tries) || 3, baseMs: retry.baseMs ?? 600 };
}

/**
 * Low-level webhook request. GET when `body` is undefined, otherwise POST JSON.
 * @param {string} url
 * @param {*} body                 undefined → GET; anything else → POST JSON
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {boolean|{tries?:number,baseMs?:number}} [opts.retry=false]
 *   Optional retry capability (ported from jobscout's sheet.mjs — STRICTLY BETTER than the
 *   old no-retry client): `true` → 3 attempts, `{tries,baseMs}` to tune. Retries fire on a
 *   transient network error OR an HTTP 5xx (Apps Script flakes), with exponential backoff
 *   (baseMs·2^(n-1)). A TIMEOUT is deliberately TERMINAL — never retried: a hung endpoint
 *   won't un-hang, and stacking timeouts just burns the whole agent turn. Default OFF, so
 *   existing consumers (zorro/pitzi via pushToSheet) behave exactly as before.
 * @param {Function} [opts.fetchImpl=fetch]      injectable transport (tests only)
 * @param {Function} [opts.sleepImpl]            injectable backoff sleep (tests only)
 * @returns {Promise<{ok:boolean,status:number,text:string}|{ok:false,error:string,timeout:boolean}>}
 *   HTTP completion → { ok, status, text }; network/timeout (after retries) → { ok:false, error, timeout }.
 *   Never throws.
 */
export async function requestWebhook(url, body, {
  timeoutMs = 30000,
  retry = false,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const r = normRetry(retry);
  const tries = r ? r.tries : 1;
  const baseMs = r ? r.baseMs : 0;

  const backoff = (attempt) => sleepImpl(baseMs * 2 ** (attempt - 1));
  let lastErr;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res, text;
    try {
      const opts = { redirect: 'follow', signal: controller.signal };
      if (body !== undefined) {
        opts.method = 'POST';
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      res = await fetchImpl(url, opts);
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') return { ok: false, error: e.message, timeout: true }; // terminal
      lastErr = e;
      if (r && attempt < tries) { await backoff(attempt); continue; }
      return { ok: false, error: e.message, timeout: false };
    }
    clearTimeout(timer);
    if (res.status >= 500 && r && attempt < tries) { await backoff(attempt); continue; }
    return { ok: res.ok, status: res.status, text };
  }
  return { ok: false, error: lastErr ? lastErr.message : 'request failed', timeout: false };
}

/** Low-level POST → { ok, status, response } (response = parsed JSON or { raw }). Never throws. */
export async function postWebhook(url, body, opts = {}) {
  const r = await requestWebhook(url, body, opts);
  if (r.error) {
    return { ok: false, error: r.timeout ? `webhook timeout after ${opts.timeoutMs ?? 30000}ms` : r.error };
  }
  let parsed; try { parsed = JSON.parse(r.text); } catch { parsed = { raw: r.text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, response: parsed };
}

/**
 * Mirror an action to a bot's Sheet, gated on its config block `{ enabled, webhook_url }`.
 * Disabled/missing config → { skipped } (the JSONL ledger stays the source of truth; the Sheet
 * is a best-effort mirror). Never throws.
 */
export async function pushToSheet(sheetCfg, action, row, opts = {}) {
  if (!sheetCfg?.enabled || !sheetCfg?.webhook_url) return { skipped: 'sheet disabled' };
  return postWebhook(sheetCfg.webhook_url, { action, row }, opts);
}
