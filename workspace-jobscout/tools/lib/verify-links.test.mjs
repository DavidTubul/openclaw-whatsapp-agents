import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasHttpScheme, looksLikeUrl, isJunkUrl, classifyStatic,
  isDeadStatus, isBotBlockStatus, isHomepageCollapse, matchesDeadMarker,
  bodyIsClosed, maintenanceReason, verifyCandidate, verifyBatch,
} from './verify-links.mjs';

// ---- sheet.mjs url-guard (hasHttpScheme is the pure fn behind assertUrlFields) ----------

test('hasHttpScheme: accepts http(s), rejects garbage / bare host / empty', () => {
  assert.equal(hasHttpScheme('https://www.drushim.co.il/job/1/a/'), true);
  assert.equal(hasHttpScheme('http://example.com'), true);
  assert.equal(hasHttpScheme('  https://x.com/y  '), true); // trimmed
  assert.equal(hasHttpScheme('Senior QA Engineer at Acme'), false); // page-title text
  assert.equal(hasHttpScheme('www.linkedin.com/jobs/view/1'), false); // no scheme
  assert.equal(hasHttpScheme('ftp://host/f'), false);
  assert.equal(hasHttpScheme(''), false);
  assert.equal(hasHttpScheme(null), false);
});

// ---- looksLikeUrl (the not-a-url guard) -------------------------------------------------

test('looksLikeUrl: real job URL true; title text / bare host / empty false', () => {
  assert.equal(looksLikeUrl('https://www.drushim.co.il/job/37516529/3b48b14a/'), true);
  assert.equal(looksLikeUrl('https://jobs.lever.co/walkme/abc-123'), true);
  assert.equal(looksLikeUrl('Senior QA Engineer at Acme'), false); // has spaces
  assert.equal(looksLikeUrl('www.linkedin.com/jobs/view/1'), false); // no scheme
  assert.equal(looksLikeUrl('https://localhost'), false); // no dotted host
  assert.equal(looksLikeUrl(''), false);
  assert.equal(looksLikeUrl(null), false);
});

// ---- junk classification (search/feed pages vs real aggregator job pages) ---------------

test('isJunkUrl: glassdoor search, facebook, x, linkedin jobs-search, google search → junk', () => {
  assert.equal(isJunkUrl('https://www.glassdoor.com/Job/israel-qa-jobs-SRCH_IL.0,6.htm'), true);
  assert.equal(isJunkUrl('https://www.glassdoor.co.il/Search/results.htm?q=qa'), true);
  assert.equal(isJunkUrl('https://www.facebook.com/groups/123456'), true);
  assert.equal(isJunkUrl('https://x.com/someone/status/1'), true);
  assert.equal(isJunkUrl('https://twitter.com/someone/status/1'), true);
  assert.equal(isJunkUrl('https://www.linkedin.com/jobs/search?keywords=qa'), true);
  assert.equal(isJunkUrl('https://www.google.com/search?q=qa+jobs'), true);
});

test('isJunkUrl: real job-detail pages on IL aggregators + a LinkedIn posting are NOT junk', () => {
  assert.equal(isJunkUrl('https://www.drushim.co.il/job/37516529/3b48b14a/'), false);
  assert.equal(isJunkUrl('https://www.jobhunt.co.il/jobs/12345'), false);
  assert.equal(isJunkUrl('https://www.alljobs.co.il/SearchResultsGuest.aspx?page=1&position=1'), false);
  assert.equal(isJunkUrl('https://www.linkedin.com/jobs/view/1234567890'), false); // a posting, not search
  assert.equal(isJunkUrl('https://www.glassdoor.com/job-listing/qa-engineer-JV_IC123.htm'), false); // detail page
  assert.equal(isJunkUrl('not a url at all'), false); // malformed → not-a-url handles it
});

// ---- classifyStatic (no-network verdict, or null → needs a liveness check) --------------

test('classifyStatic: not-a-url / junk get a static verdict, real URLs fall through (null)', () => {
  assert.equal(classifyStatic({ url: 'Senior QA Engineer at Acme' }).verdict, 'not-a-url');
  assert.equal(classifyStatic({ url: '' }).verdict, 'not-a-url');
  assert.equal(classifyStatic({ url: 'https://www.facebook.com/groups/1' }).verdict, 'junk');
  assert.equal(classifyStatic({ url: 'https://www.drushim.co.il/job/1/ab/' }), null);
});

// ---- dead-status / bot-block classification --------------------------------------------

test('isDeadStatus / isBotBlockStatus split confirmed-death from bot-blocking', () => {
  assert.equal(isDeadStatus(404), true);
  assert.equal(isDeadStatus(410), true);
  assert.equal(isDeadStatus(200), false);
  assert.equal(isDeadStatus(403), false); // bot-block, not death
  assert.equal(isBotBlockStatus(403), true);
  assert.equal(isBotBlockStatus(429), true);
  assert.equal(isBotBlockStatus(999), true);
  assert.equal(isBotBlockStatus(404), false);
});

// ---- homepage-collapse detection (posting gone → server bounces to site root) -----------

test('isHomepageCollapse: deep→root bounce true; was-always-root false; live deep page false', () => {
  // lever 404 → bounced to site root
  assert.equal(isHomepageCollapse('https://jobs.lever.co/', 'https://jobs.lever.co/walkme/abc-123'), true);
  // drushim dead job bounces to /jobs
  assert.equal(isHomepageCollapse('https://www.drushim.co.il/jobs', 'https://www.drushim.co.il/job/1/ab/'), true);
  // was always the homepage → not a collapse
  assert.equal(isHomepageCollapse('https://example.com/', 'https://example.com/'), false);
  // still on a deep posting page → live
  assert.equal(isHomepageCollapse('https://example.com/jobs/xyz', 'https://example.com/jobs/xyz'), false);
  assert.equal(isHomepageCollapse('garbage', 'https://example.com/x'), false); // unparseable final
});

// ---- dead-marker matching (Workable /oops, not_found=true) ------------------------------

test('matchesDeadMarker: workable /oops and not_found=true; live workable page false', () => {
  assert.equal(matchesDeadMarker('https://apply.workable.com/oops'), true);
  assert.equal(matchesDeadMarker('https://x.workable.com/oops/'), true);
  assert.equal(matchesDeadMarker('https://boards.example.com/x?not_found=true'), true);
  assert.equal(matchesDeadMarker('https://apply.workable.com/some-co/j/ABC123/'), false);
  assert.equal(matchesDeadMarker('https://example.com/jobs/1'), false);
});

// ---- closed-posting body markers (Hebrew + English) ------------------------------------

test('bodyIsClosed: matches closed markers, ignores a normal apply page', () => {
  assert.equal(bodyIsClosed('<p>This position has been filled.</p>'), true);
  assert.equal(bodyIsClosed('Sorry, this job is NO LONGER AVAILABLE'), true); // case-insensitive
  assert.equal(bodyIsClosed('<div>המשרה אוישה, תודה</div>'), true); // standard IL filled-position notice
  assert.equal(bodyIsClosed('<div>המשרה לא נמצאה במערכת</div>'), true);
  assert.equal(bodyIsClosed('<h1>Apply now — we are hiring!</h1>'), false);
  assert.equal(bodyIsClosed(''), false);
  assert.equal(bodyIsClosed(null), false);
  // regression: a generic 'לא נמצאה תוצאה' (search widget "no result") must NOT mark a live job closed
  assert.equal(bodyIsClosed('<h1>Apply now!</h1><div class="search">לא נמצאה תוצאה</div>'), false);
});

// ---- maintenance Hebrew reason strings --------------------------------------------------

test('maintenanceReason: a short Hebrew reason per verdict', () => {
  assert.match(maintenanceReason('dead'), /מת/);
  assert.match(maintenanceReason('not-a-url'), /קישור/);
  assert.match(maintenanceReason('junk'), /חיפוש/);
  assert.equal(typeof maintenanceReason('ok'), 'string');
});

// ---- verifyCandidate (liveness path, injectable fetch/linkedin) -------------------------

const okFetch = (finalUrl, body = 'apply now', status = 200) => async () => ({ status, finalUrl, body });

test('verifyCandidate: static verdicts short-circuit without any fetch', async () => {
  let called = 0;
  const spy = async () => { called++; return { status: 200, finalUrl: 'x', body: '' }; };
  const notUrl = await verifyCandidate({ id: 'a', url: 'Senior QA at Acme' }, { fetchImpl: spy });
  assert.equal(notUrl.verdict, 'not-a-url');
  const junk = await verifyCandidate({ id: 'b', url: 'https://www.facebook.com/groups/1' }, { fetchImpl: spy });
  assert.equal(junk.verdict, 'junk');
  assert.equal(called, 0); // no network for static verdicts
});

test('verifyCandidate: 200 with a normal body → ok/live', async () => {
  const url = 'https://www.drushim.co.il/job/1/ab/';
  const r = await verifyCandidate({ id: '1', url }, { fetchImpl: okFetch(url) });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.reason, 'live');
});

test('verifyCandidate: 404 → dead', async () => {
  const url = 'https://jobs.lever.co/walkme/abc-123';
  const r = await verifyCandidate({ id: '2', url }, { fetchImpl: okFetch(url, '', 404) });
  assert.equal(r.verdict, 'dead');
  assert.match(r.reason, /404/);
});

test('verifyCandidate: redirect to site homepage → dead', async () => {
  const url = 'https://jobs.lever.co/walkme/abc-123';
  const r = await verifyCandidate({ id: '3', url }, { fetchImpl: okFetch('https://jobs.lever.co/') });
  assert.equal(r.verdict, 'dead');
  assert.match(r.reason, /homepage/);
});

test('verifyCandidate: workable /oops final URL → dead', async () => {
  const url = 'https://apply.workable.com/some-co/j/ABC/';
  const r = await verifyCandidate({ id: '4', url }, { fetchImpl: okFetch('https://apply.workable.com/oops') });
  assert.equal(r.verdict, 'dead');
});

test('verifyCandidate: closed-posting body text → dead', async () => {
  const url = 'https://example.com/jobs/1';
  const r = await verifyCandidate({ id: '5', url }, { fetchImpl: okFetch(url, 'This position has been filled') });
  assert.equal(r.verdict, 'dead');
});

test('verifyCandidate: bot-block (403) → ok/unverifiable (fail open)', async () => {
  const url = 'https://example.com/jobs/1';
  const r = await verifyCandidate({ id: '6', url }, { fetchImpl: okFetch(url, '', 403) });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.reason, 'unverifiable');
});

test('verifyCandidate: fetch throws (after one retry) → ok/unverifiable (fail open)', async () => {
  const url = 'https://example.com/jobs/1';
  let calls = 0;
  const throwing = async () => { calls++; throw new Error('ECONNRESET'); };
  const r = await verifyCandidate({ id: '7', url }, { fetchImpl: throwing });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.reason, 'unverifiable');
  assert.equal(calls, 2); // one retry
});

test('verifyCandidate: LinkedIn view URL uses the injected linkedinCheck', async () => {
  const url = 'https://www.linkedin.com/jobs/view/1234567890';
  const open = await verifyCandidate({ id: '8', url }, { linkedinCheck: async () => true });
  assert.equal(open.verdict, 'ok');
  const closed = await verifyCandidate({ id: '9', url }, { linkedinCheck: async () => false });
  assert.equal(closed.verdict, 'dead');
});

// ---- verifyBatch (bounded concurrency, order preserved) ---------------------------------

test('verifyBatch: preserves input order and classifies a mixed list', async () => {
  const live = 'https://www.drushim.co.il/job/1/ab/';
  const dead = 'https://jobs.lever.co/walkme/abc-123';
  const fetchImpl = async (u) => (u === dead ? { status: 404, finalUrl: u, body: '' } : { status: 200, finalUrl: u, body: 'apply' });
  const cands = [
    { id: 'live', url: live },
    { id: 'garbage', url: 'Senior QA at Acme' },
    { id: 'junk', url: 'https://www.google.com/search?q=qa' },
    { id: 'dead', url: dead },
  ];
  const results = await verifyBatch(cands, { fetchImpl });
  assert.deepEqual(results.map((r) => r.id), ['live', 'garbage', 'junk', 'dead']);
  assert.deepEqual(results.map((r) => r.verdict), ['ok', 'not-a-url', 'junk', 'dead']);
});
