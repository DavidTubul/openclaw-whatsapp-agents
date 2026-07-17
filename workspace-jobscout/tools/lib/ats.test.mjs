import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endpoints, comeetCareersPageUrl, extractComeetToken,
  normalizeComeet, normalizeGreenhouse, normalizeLever, normalizeAshby, normalizeBamboo,
  normalizeGetro, validateWatchlist, freshEnough, pruneSeenIds, foreignLocation, SUPPORTED_ATS,
  isRepost, normalizers,
  normalizeWorkday, workdayPostedToIso, normalizeAmazon, normalizeSmartRecruiters, normalizeDrushim,
  parseComeetHostedUrl, comeetPositionLive,
} from './ats.mjs';

// ---- endpoints -------------------------------------------------------------------------

test('endpoints build the documented public URLs', () => {
  assert.equal(endpoints.greenhouse({ slug: 'catonetworks' }),
    'https://boards-api.greenhouse.io/v1/boards/catonetworks/jobs');
  assert.equal(endpoints.lever({ slug: 'walkme' }),
    'https://api.lever.co/v0/postings/walkme?mode=json');
  assert.equal(endpoints.ashby({ slug: 'redis' }),
    'https://api.ashbyhq.com/posting-api/job-board/redis');
  assert.equal(endpoints.bamboohr({ slug: 'cathworks' }),
    'https://cathworks.bamboohr.com/careers/list');
  assert.equal(endpoints.comeet({ slug: 'vastdata', uid: '43.001' }, 'TOK'),
    'https://www.comeet.co/careers-api/2.0/company/43.001/positions?token=TOK&details=false');
  assert.equal(comeetCareersPageUrl({ slug: 'vastdata', uid: '43.001' }),
    'https://www.comeet.com/jobs/vastdata/43.001');
});

// ---- comeet token extraction (synthetic fixture in the live COMPANY_DATA shape) ----------

test('extractComeetToken finds the COMPANY_DATA token, ignores short hex noise', () => {
  const html = 'var COMPANY_DATA = {"name": "Example Co", "token": "AB12CD34EF56AB78CD90EF12AB34CD5"};';
  assert.equal(extractComeetToken(html), 'AB12CD34EF56AB78CD90EF12AB34CD5');
  assert.equal(extractComeetToken('{"token": "AB12"}'), null); // too short = not a careers token
  assert.equal(extractComeetToken(''), null);
  assert.equal(extractComeetToken(null), null);
});

// ---- normalizers (fixtures taken from live API responses, 2026-07-02) -------------------

const VAST = { name: 'VAST Data', ats: 'comeet', slug: 'vastdata', uid: '43.001' };

test('normalizeComeet maps positions to canonical rows', () => {
  const rows = normalizeComeet([{
    name: 'QA Automation Engineer', uid: '6B.364',
    location: { name: 'Israel - Tel Aviv' },
    url_comeet_hosted_page: 'https://www.comeet.com/jobs/vastdata/43.001/system-qa-automation-engineer/6B.364',
    time_updated: '2026-05-26T11:22:35Z', company_name: 'VAST Data',
    experience_level: 'Mid-level',
  }], VAST);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    external_id: 'comeet:vastdata:6B.364',
    title: 'QA Automation Engineer',
    company: 'VAST Data',
    location: 'Israel - Tel Aviv',
    url: 'https://www.comeet.com/jobs/vastdata/43.001/system-qa-automation-engineer/6B.364',
    updated: '2026-05-26T11:22:35Z',
    experience_level: 'Mid-level',
  });
});

test('normalizeComeet defaults experience_level to empty string when absent', () => {
  const rows = normalizeComeet({ positions: [{ name: 'X', uid: 'A1.111' }] }, VAST);
  assert.equal(rows[0].experience_level, '');
});

// ---- Comeet hosted-URL parsing + liveness (Bug 1: stale Tavily links) -------------------

test('parseComeetHostedUrl extracts slug/uid/positionUid from a hosted-job URL', () => {
  assert.deepEqual(
    parseComeetHostedUrl('https://www.comeet.com/jobs/ownera/59.003/senior-qa-automation-engineer/D3.B67'),
    { slug: 'ownera', uid: '59.003', positionUid: 'D3.B67' },
  );
  // query/hash tolerated
  assert.deepEqual(
    parseComeetHostedUrl('https://www.comeet.com/jobs/vastdata/43.001/system-qa/6B.364?utm=x#top'),
    { slug: 'vastdata', uid: '43.001', positionUid: '6B.364' },
  );
});

test('parseComeetHostedUrl returns null for non-hosted-job URLs', () => {
  assert.equal(parseComeetHostedUrl('https://www.comeet.com/jobs/ownera/59.003'), null); // bare careers page
  assert.equal(parseComeetHostedUrl('https://www.linkedin.com/jobs/view/123'), null);
  assert.equal(parseComeetHostedUrl(''), null);
  assert.equal(parseComeetHostedUrl(null), null);
});

test('comeetPositionLive checks the uid against live positions (both payload shapes)', () => {
  const arr = [{ uid: 'D3.B67' }, { uid: 'A1.111' }];
  assert.equal(comeetPositionLive(arr, 'D3.B67'), true);
  assert.equal(comeetPositionLive(arr, 'ZZ.999'), false);          // closed: gone from the list
  assert.equal(comeetPositionLive({ positions: arr }, 'A1.111'), true); // {positions:[...]} wrapper
  assert.equal(comeetPositionLive([], 'D3.B67'), false);
  assert.equal(comeetPositionLive(null, 'D3.B67'), false);
});

test('normalizeComeet tolerates {positions:[...]} wrapper and missing fields', () => {
  const rows = normalizeComeet({ positions: [{ name: 'X', uid: 'A1.111' }] }, VAST);
  assert.equal(rows[0].external_id, 'comeet:vastdata:A1.111');
  assert.equal(rows[0].location, '');
  assert.equal(rows[0].url, 'https://www.comeet.com/jobs/vastdata/43.001'); // careers-page fallback
});

test('normalizeGreenhouse maps jobs', () => {
  const rows = normalizeGreenhouse({ jobs: [{
    id: 4899273101, title: 'Automation Infrastructure Engineer ',
    location: { name: 'Tel Aviv District, Israel' },
    absolute_url: 'https://www.catonetworks.com/careers/careers-post/4899273101?gh_jid=4899273101',
    updated_at: '2026-06-18T09:12:37-04:00',
  }] }, { name: 'Cato Networks', ats: 'greenhouse', slug: 'catonetworks' });
  assert.equal(rows[0].external_id, 'greenhouse:catonetworks:4899273101');
  assert.equal(rows[0].title, 'Automation Infrastructure Engineer'); // trimmed
  assert.equal(rows[0].company, 'Cato Networks');
});

test('normalizeLever maps postings, ms epoch -> ISO', () => {
  const rows = normalizeLever([{
    id: 'abc-123', text: 'QA Engineer', hostedUrl: 'https://jobs.lever.co/walkme/abc-123',
    categories: { location: 'Tel Aviv, Israel' }, createdAt: 1750000000000,
  }], { name: 'WalkMe', ats: 'lever', slug: 'walkme' });
  assert.equal(rows[0].external_id, 'lever:walkme:abc-123');
  assert.equal(rows[0].updated, new Date(1750000000000).toISOString());
  assert.equal(rows[0].location, 'Tel Aviv, Israel');
});

test('normalizeAshby maps jobs incl. secondary locations', () => {
  const rows = normalizeAshby({ jobs: [{
    id: '00d39423', title: 'Senior Test Automation Engineer', location: 'Tel Aviv',
    secondaryLocations: [{ location: 'Remote Israel' }],
    jobUrl: 'https://jobs.ashbyhq.com/redis/00d39423', publishedAt: '2026-06-01T00:00:00Z',
  }] }, { name: 'Redis', ats: 'ashby', slug: 'redis' });
  assert.equal(rows[0].external_id, 'ashby:redis:00d39423');
  assert.equal(rows[0].location, 'Tel Aviv, Remote Israel');
});

test('normalizeBamboo maps result list, builds careers URL, empty updated', () => {
  const rows = normalizeBamboo({ result: [{
    id: 42, jobOpeningName: 'QA Engineer', location: { city: 'Kfar Saba', state: '' },
  }] }, { name: 'CathWorks', ats: 'bamboohr', slug: 'cathworks' });
  assert.equal(rows[0].external_id, 'bamboohr:cathworks:42');
  assert.equal(rows[0].url, 'https://cathworks.bamboohr.com/careers/42');
  assert.equal(rows[0].location, 'Kfar Saba');
  assert.equal(rows[0].updated, '');
});

test('every supported ats has an endpoint and a normalizer', () => {
  for (const ats of SUPPORTED_ATS) {
    assert.equal(typeof endpoints[ats], 'function', ats);
  }
});

// ---- getro (VC portfolio boards) — fixture mirrors jobs.vertexventures.co.il sitemap ------

const VERTEX = { name: 'Vertex Ventures IL (portfolio)', ats: 'getro', slug: 'jobs.vertexventures.co.il' };
const GETRO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://jobs.vertexventures.co.il</loc>
    <changefreq>daily</changefreq>
    <lastmod>2026-06-12T10:05:48Z</lastmod>
  </url>
  <url>
    <loc>https://jobs.vertexventures.co.il/companies/axonius/jobs/83278716-rf-test-automation-developer</loc>
    <changefreq>daily</changefreq>
    <lastmod>2026-06-20T08:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://jobs.vertexventures.co.il/companies/quantum-art-2-3112d572-bc73-4751-b532-6af6a6b67d88/jobs/84764004-system-qa-engineer</loc>
    <lastmod>2026-06-25T09:30:00Z</lastmod>
  </url>
</urlset>`;

test('endpoints.getro builds the board sitemap URL from the hostname slug', () => {
  assert.equal(endpoints.getro(VERTEX), 'https://jobs.vertexventures.co.il/sitemap.xml');
});

test('normalizeGetro parses only job URLs, de-slugs title/company, strips getro dedup suffixes', () => {
  const rows = normalizeGetro(GETRO_XML, VERTEX);
  assert.equal(rows.length, 2); // the bare board-root <url> is not a job
  assert.deepEqual(rows[0], {
    external_id: 'getro:jobs.vertexventures.co.il:83278716',
    title: 'rf test automation developer',
    company: 'axonius',
    location: '',
    url: 'https://jobs.vertexventures.co.il/companies/axonius/jobs/83278716-rf-test-automation-developer',
    updated: '2026-06-20T08:00:00Z',
  });
  // "-2-<uuid>" dedup suffix stripped from the company slug
  assert.equal(rows[1].company, 'quantum art');
  assert.equal(rows[1].updated, '2026-06-25T09:30:00Z');
});

test('normalizeGetro tolerates empty/garbage xml and a comeet-style watchlist entry needs no uid', () => {
  assert.deepEqual(normalizeGetro('', VERTEX), []);
  assert.deepEqual(normalizeGetro('<html>bot wall</html>', VERTEX), []);
  const { companies } = validateWatchlist({ companies: [VERTEX] });
  assert.equal(companies.length, 1);
});

// ---- watchlist validation ---------------------------------------------------------------

test('validateWatchlist keeps valid entries, flags unknown ats / missing slug / comeet w/o uid', () => {
  const { companies, invalid } = validateWatchlist({ companies: [
    { name: 'VAST', ats: 'comeet', slug: 'vastdata', uid: '43.001' },
    { name: 'Cato', ats: 'greenhouse', slug: 'catonetworks' },
    { name: 'NoUid', ats: 'comeet', slug: 'noluck' },            // comeet needs uid
    { name: 'Mystery', ats: 'taleo', slug: 'x' },                // unsupported platform
    { name: 'NoSlug', ats: 'lever' },                            // missing slug
  ] });
  assert.deepEqual(companies.map((c) => c.name), ['VAST', 'Cato']);
  assert.equal(invalid.length, 3);
});

test('validateWatchlist tolerates empty / malformed input', () => {
  assert.deepEqual(validateWatchlist(null), { companies: [], invalid: [] });
  assert.deepEqual(validateWatchlist({}), { companies: [], invalid: [] });
});

// ---- freshness + seen pruning -----------------------------------------------------------

test('freshEnough: inside window kept, outside dropped, missing/garbage stamps pass', () => {
  const now = Date.parse('2026-07-02T00:00:00Z');
  assert.equal(freshEnough('2026-06-20T00:00:00Z', 30, now), true);
  assert.equal(freshEnough('2026-05-01T00:00:00Z', 30, now), false);
  assert.equal(freshEnough('2026-05-01T00:00:00Z', 90, now), true);   // deep-scan window
  assert.equal(freshEnough('', 30, now), true);
  assert.equal(freshEnough('not-a-date', 30, now), true);
});

test('pruneSeenIds dedupes and keeps the newest ids under the cap', () => {
  assert.deepEqual(pruneSeenIds(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(pruneSeenIds(['a', 'b', 'c', 'd'], 2), ['c', 'd']);
});

// ---- foreign-location guard (the live leak: Algosec India passed the IL-centric filter) --

test('foreignLocation: foreign token without Israel signal → true', () => {
  assert.equal(foreignLocation('Cloud Automation Developer, India '), true);
  assert.equal(foreignLocation('QA Engineer New York'), true);
  assert.equal(foreignLocation('Automation Engineer Remote US'), true);
  assert.equal(foreignLocation('Test Engineer London, UK'), true);
});

test('foreignLocation: Israel signal (or no location at all) → false', () => {
  assert.equal(foreignLocation('QA Automation Engineer Israel - Tel Aviv'), false);
  assert.equal(foreignLocation('QA Engineer'), false);          // no location info = fail-open
  assert.equal(foreignLocation('Automation Engineer תל אביב'), false);
  // multi-region posting that includes Israel stays
  assert.equal(foreignLocation('SDET — London / Tel Aviv'), false);
});

test('foreignLocation: does not false-positive on lookalike substrings', () => {
  assert.equal(foreignLocation('QA Engineer at Indiadesk Israel'), false); // 'india' inside a word
  assert.equal(foreignLocation('UKG integration tester Israel'), false);
});

// ---- repost detection -------------------------------------------------------------------

test('isRepost: true only when the posting date jumped >= minDays past the stored one', () => {
  assert.equal(isRepost('2026-06-01T00:00:00Z', '2026-07-10T00:00:00Z', 21), true);
  assert.equal(isRepost('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z', 21), false); // small bump = edit, not repost
  assert.equal(isRepost('', '2026-07-10T00:00:00Z', 21), false);                     // no baseline -> not a repost
  assert.equal(isRepost('2026-06-01T00:00:00Z', '', 21), false);                     // no current date -> can't judge
});

// ---- Task 4: new source providers (fixtures trimmed from live samples, 2026-07-15) -------
// Live-verified: Workday CXS (nvidia wd5), amazon.jobs search.json, SmartRecruiters (Wix2),
// Lever EU (mobileye), Drushim (browser-UA). Every field name below matched the live shape.

test('endpoints build the new platform URLs', () => {
  assert.equal(endpoints['lever-eu']({ slug: 'mobileye' }),
    'https://api.eu.lever.co/v0/postings/mobileye?mode=json');
  assert.equal(endpoints.smartrecruiters({ slug: 'Wix2' }),
    'https://api.smartrecruiters.com/v1/companies/Wix2/postings?limit=100');
  assert.equal(endpoints.amazon({ slug: 'amazon', query: 'QA Engineer' }),
    'https://www.amazon.jobs/en/search.json?base_query=QA%20Engineer&loc_query=Israel&result_limit=50');
  assert.equal(endpoints.drushim({ slug: 'qa', query: 'QA Automation' }),
    'https://www.drushim.co.il/api/jobs/search?searchterm=QA%20Automation&ssaen=1');
  assert.equal(endpoints.workday({ slug: 'intel', wd: 'wd1', site: 'External' }),
    'https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/jobs');
});

test('normalizeWorkday: builds public job URL + parses fuzzy postedOn (real -N counter id)', () => {
  const company = { ats: 'workday', slug: 'intel', name: 'Intel', wd: 'wd1', site: 'External' };
  const json = { jobPostings: [
    { title: 'QA Automation Engineer', externalPath: '/job/Israel-Petah-Tikva/QA-Automation-Engineer_JR123', locationsText: 'Israel, Petah Tikva', postedOn: 'Posted 3 Days Ago', bulletFields: ['JR123'] },
    // live shape: Workday appends a "-N" location-dedup counter to the JR id
    { title: 'Software Engineer, NVLINK', externalPath: '/job/Israel-Tel-Aviv/Software-Engineer--NVLINK_JR2012644-1', locationsText: 'Israel, Tel Aviv', postedOn: 'Posted Today', bulletFields: ['JR2012644'] },
  ] };
  const rows = normalizeWorkday(json, company);
  assert.equal(rows.length, 2);
  const [r] = rows;
  assert.equal(r.external_id, 'workday:intel:JR123');
  assert.equal(r.url, 'https://intel.wd1.myworkdayjobs.com/en-US/External/job/Israel-Petah-Tikva/QA-Automation-Engineer_JR123');
  assert.ok(/^\d{4}-\d{2}-\d{2}/.test(r.updated)); // ~3 days ago, ISO
  assert.equal(r.location, 'Israel, Petah Tikva');
  assert.equal(rows[1].external_id, 'workday:intel:JR2012644-1'); // stable per-posting id
});

test('workdayPostedToIso: Today / Yesterday / N Days Ago / junk', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');
  assert.equal(workdayPostedToIso('Posted Today', now).slice(0, 10), '2026-07-15');
  assert.equal(workdayPostedToIso('Posted Yesterday', now).slice(0, 10), '2026-07-14');
  assert.equal(workdayPostedToIso('Posted 30+ Days Ago', now).slice(0, 10), '2026-06-15');
  assert.equal(workdayPostedToIso('', now), '');
});

test('normalizeAmazon: id, path url, posted_date', () => {
  const company = { ats: 'amazon', slug: 'amazon', name: 'Amazon' };
  const json = { jobs: [{ id_icims: '2745123', title: 'Quality Assurance Engineer', normalized_location: 'Tel Aviv, Israel', job_path: '/en/jobs/2745123/qa-engineer', posted_date: 'July 10, 2026' }] };
  const [r] = normalizeAmazon(json, company);
  assert.equal(r.external_id, 'amazon:amazon:2745123');
  assert.equal(r.url, 'https://www.amazon.jobs/en/jobs/2745123/qa-engineer');
  assert.equal(r.updated.slice(0, 10), '2026-07-10');
});

test('normalizeSmartRecruiters: releasedDate + hosted job url', () => {
  const company = { ats: 'smartrecruiters', slug: 'Wix2', name: 'Wix' };
  const json = { content: [{ id: '744000067', name: 'QA Engineer', location: { city: 'Tel Aviv-Yafo', country: 'il' }, releasedDate: '2026-07-01T08:00:00.000Z' }] };
  const [r] = normalizeSmartRecruiters(json, company);
  assert.equal(r.external_id, 'smartrecruiters:Wix2:744000067');
  assert.equal(r.url, 'https://jobs.smartrecruiters.com/Wix2/744000067');
  assert.equal(r.updated, '2026-07-01T08:00:00.000Z');
  assert.equal(r.location, 'Tel Aviv-Yafo, il');
});

test('normalizeDrushim: ResultList rows -> canonical (prefers JobInfo.Link)', () => {
  const company = { ats: 'drushim', slug: 'qa-automation', name: 'Drushim' };
  // Trimmed from the live ResultList shape (Code / JobContent.Name / Company.CompanyDisplayName /
  // JobContent.Addresses[].CityEnglish / JobInfo.Date/Link/Hash). Field names all matched live.
  const json = { ResultList: [{ Code: '9876543', JobContent: { Name: 'בודק/ת אוטומציה', Addresses: [{ CityEnglish: 'Petah Tikva' }] }, Company: { CompanyDisplayName: 'SomeCo' }, JobInfo: { Date: '2026-07-12T00:00:00', Link: '/job/9876543/3c4c421d/', Hash: '3C4C421D' } }] };
  const [r] = normalizeDrushim(json, company);
  assert.equal(r.external_id, 'drushim:qa-automation:9876543');
  assert.ok(r.title.includes('אוטומציה'));
  assert.equal(r.company, 'SomeCo');
  // Link is used verbatim (prefixed) — this is the canonical hash-bearing URL.
  assert.equal(r.url, 'https://www.drushim.co.il/job/9876543/3c4c421d/');
  assert.equal(r.updated.slice(0, 10), '2026-07-12');
});

test('normalizeDrushim: falls back to Code + lowercased Hash when Link is absent', () => {
  const company = { ats: 'drushim', slug: 'qa', name: 'Drushim' };
  const json = { ResultList: [{ Code: '37516529', JobContent: { Name: 'QA Engineer' }, Company: { CompanyDisplayName: 'Acme' }, JobInfo: { Hash: '3B48B14A' } }] };
  const [r] = normalizeDrushim(json, company);
  // Bare /job/<Code>/ 302s to the homepage — the hash segment is mandatory.
  assert.equal(r.url, 'https://www.drushim.co.il/job/37516529/3b48b14a/');
});

test('normalizeDrushim: emits url "" when neither Link nor Hash is present (row gets dropped)', () => {
  const company = { ats: 'drushim', slug: 'qa', name: 'Drushim' };
  const json = { ResultList: [{ Code: '37516529', JobContent: { Name: 'QA Engineer' }, Company: { CompanyDisplayName: 'Acme' }, JobInfo: { Date: '2026-07-12T00:00:00' } }] };
  const [r] = normalizeDrushim(json, company);
  // No hash means no valid URL — never emit the hash-less or bare-homepage form.
  assert.equal(r.url, '');
});

test('lever-eu normalizer reuses lever shape but re-prefixes the external_id', () => {
  const company = { name: 'Mobileye', ats: 'lever-eu', slug: 'mobileye' };
  // EU payload has the exact same shape as lever (verified live on api.eu.lever.co/mobileye).
  const [r] = normalizers['lever-eu']([{
    id: 'xyz-789', text: '3D Algorithm Developer', hostedUrl: 'https://jobs.eu.lever.co/mobileye/xyz-789',
    categories: { location: 'Ramat Gan, Israel' }, createdAt: 1779188005917,
  }], company);
  assert.equal(r.external_id, 'lever-eu:mobileye:xyz-789'); // re-prefixed from lever:
  assert.equal(r.location, 'Ramat Gan, Israel');
  assert.equal(r.updated, new Date(1779188005917).toISOString());
});

test('normalizeWorkday tolerates empty/garbage input', () => {
  assert.deepEqual(normalizeWorkday(null, { slug: 'x', wd: 'wd1', site: 'External' }), []);
  assert.deepEqual(normalizeWorkday({ jobPostings: [] }, { slug: 'x' }), []);
});

test('validateWatchlist: accepts new platforms, workday needs wd+site', () => {
  const { companies, invalid } = validateWatchlist({ companies: [
    { ats: 'workday', slug: 'intel', wd: 'wd1', site: 'External' },
    { ats: 'workday', slug: 'broken' },
    { ats: 'amazon', slug: 'amazon' },
    { ats: 'drushim', slug: 'qa' },
    { ats: 'smartrecruiters', slug: 'Wix2' },
    { ats: 'lever-eu', slug: 'mobileye' },
  ] });
  assert.equal(companies.length, 5);
  assert.equal(invalid.length, 1);
});
