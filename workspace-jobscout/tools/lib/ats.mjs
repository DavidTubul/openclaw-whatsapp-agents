// Direct ATS (career-page) job discovery — pure logic + per-platform normalizers.
// Validated 2026-07-02: polling the public, no-auth JSON endpoints of the ATS platforms
// Israeli tech actually hires through (Comeet dominant, then Greenhouse/Lever/Ashby/BambooHR)
// surfaces relevant openings LinkedIn's guest feed never showed us (12 never-seen QA roles
// from a 19-company probe, incl. 5 open automation roles at Cato Networks alone).
// The network layer lives in tools/ats.mjs; everything here is unit-testable without I/O.

export const SUPPORTED_ATS = ['comeet', 'greenhouse', 'lever', 'lever-eu', 'ashby', 'bamboohr', 'getro', 'workday', 'amazon', 'smartrecruiters', 'drushim'];

// Endpoint builders — each returns the URL of the platform's public positions JSON.
// Comeet is the exception: its careers-api needs a per-company token scraped from the
// company's hosted careers page (see comeetCareersPageUrl + extractComeetToken).
export const endpoints = {
  greenhouse: (c) => `https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`,
  lever: (c) => `https://api.lever.co/v0/postings/${c.slug}?mode=json`,
  ashby: (c) => `https://api.ashbyhq.com/posting-api/job-board/${c.slug}`,
  bamboohr: (c) => `https://${c.slug}.bamboohr.com/careers/list`,
  comeet: (c, token) =>
    `https://www.comeet.co/careers-api/2.0/company/${c.uid}/positions?token=${token}&details=false`,
  // Getro = the VC portfolio job boards (e.g. jobs.vertexventures.co.il). Their search API is
  // gated, but the sitemap lists every live job URL + lastmod — one GET covers the whole board.
  // slug = the board's hostname; each job row carries its own portfolio-company name.
  getro: (c) => `https://${c.slug}/sitemap.xml`,
  // Lever's EU-residency shard — identical payload shape to lever, different host.
  'lever-eu': (c) => `https://api.eu.lever.co/v0/postings/${c.slug}?mode=json`,
  smartrecruiters: (c) => `https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?limit=100`,
  // Amazon/Drushim are global keyword searches (no per-company board): the watchlist entry
  // carries a `query`; loc is pinned to Israel for amazon, ssaen=1 = English results for drushim.
  amazon: (c) => `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(c.query || 'QA Engineer')}&loc_query=Israel&result_limit=50`,
  drushim: (c) => `https://www.drushim.co.il/api/jobs/search?searchterm=${encodeURIComponent(c.query || 'QA Automation')}&ssaen=1`,
  // Workday CXS list endpoint (POST-only — the request body is built in tools/ats.mjs).
  workday: (c) => `https://${c.slug}.${c.wd}.myworkdayjobs.com/wday/cxs/${c.slug}/${c.site}/jobs`,
};

export const comeetCareersPageUrl = (c) => `https://www.comeet.com/jobs/${c.slug}/${c.uid}`;

// The hosted careers page embeds COMPANY_DATA = {..., "token": "<hex>"} for its own API calls.
export function extractComeetToken(html) {
  const m = String(html || '').match(/token"\s*:\s*"([0-9A-F]{16,})"/i);
  return m ? m[1] : null;
}

// A Comeet hosted-job URL is https://www.comeet.com/jobs/<slug>/<uid>/<title-slug>/<position-uid>.
// Returns { slug, uid, positionUid } (uid = company id for the token/positions call; positionUid =
// the last segment, the id we check against the live positions list) — or null if it isn't a
// hosted-job URL (e.g. the bare careers page /jobs/<slug>/<uid> has no position segment → skip it).
export function parseComeetHostedUrl(url) {
  const m = String(url || '').match(/comeet\.com\/jobs\/([^/?#]+)\/([^/?#]+)\/[^/?#]+\/([^/?#]+)/i);
  return m ? { slug: m[1], uid: m[2], positionUid: m[3] } : null;
}

// True if positionUid still appears in the company's live positions payload. Tolerates both the
// bare-array and {positions:[...]} shapes, like normalizeComeet. Caller fails OPEN on fetch error.
export function comeetPositionLive(positions, positionUid) {
  const arr = Array.isArray(positions) ? positions : positions?.positions || [];
  return arr.some((p) => String(p.uid) === String(positionUid));
}

// ---- Normalizers: raw platform JSON -> canonical rows ----------------------------------
// Canonical row: { external_id, title, company, location, url, updated } (updated = ISO or '').

export function normalizeComeet(json, company) {
  const arr = Array.isArray(json) ? json : json?.positions || [];
  return arr.map((p) => ({
    external_id: `comeet:${company.slug}:${p.uid || p.url_comeet_hosted_page || p.name}`,
    title: String(p.name || '').trim(),
    company: company.name || p.company_name || company.slug,
    location: p.location?.name || '',
    url: p.url_comeet_hosted_page || p.position_url || comeetCareersPageUrl(company),
    updated: p.time_updated || '',
    experience_level: p.experience_level || '', // extra context for the LLM seniority tag (🎚️)
  }));
}

export function normalizeGreenhouse(json, company) {
  return (json?.jobs || []).map((p) => ({
    external_id: `greenhouse:${company.slug}:${p.id}`,
    title: String(p.title || '').trim(),
    company: company.name || company.slug,
    location: p.location?.name || '',
    url: p.absolute_url || '',
    updated: p.updated_at || '',
  }));
}

export function normalizeLever(json, company) {
  return (Array.isArray(json) ? json : []).map((p) => ({
    external_id: `lever:${company.slug}:${p.id}`,
    title: String(p.text || '').trim(),
    company: company.name || company.slug,
    location: p.categories?.location || '',
    url: p.hostedUrl || '',
    updated: Number.isFinite(p.createdAt) ? new Date(p.createdAt).toISOString() : '',
  }));
}

export function normalizeAshby(json, company) {
  return (json?.jobs || []).map((p) => ({
    external_id: `ashby:${company.slug}:${p.id}`,
    title: String(p.title || '').trim(),
    company: company.name || company.slug,
    location: [p.location, p.secondaryLocations?.map((s) => s.location).join(', ')]
      .filter(Boolean).join(', '),
    url: p.jobUrl || p.applyUrl || '',
    updated: p.publishedAt || '',
  }));
}

export function normalizeBamboo(json, company) {
  return (json?.result || []).map((p) => ({
    external_id: `bamboohr:${company.slug}:${p.id}`,
    title: String(p.jobOpeningName || '').trim(),
    company: company.name || company.slug,
    location: [p.location?.city, p.location?.state].filter(Boolean).join(', '),
    url: `https://${company.slug}.bamboohr.com/careers/${p.id}`,
    updated: '', // BambooHR's public list carries no timestamp
  }));
}

// Getro job URLs look like /companies/<company-slug>/jobs/<id>-<title-slug>. The company slug
// may carry Getro's dedup suffixes (a trailing "-2" counter and/or a uuid) — strip them.
const GETRO_JOB_RE = /<loc>\s*(https?:\/\/[^<]+\/companies\/([^/<]+)\/jobs\/(\d+)-([^/<]+?))\s*<\/loc>([\s\S]*?)<\/url>/g;
const deslug = (s) => String(s || '').replace(/-/g, ' ').trim();

export function normalizeGetro(xml, company) {
  const rows = [];
  for (const m of String(xml || '').matchAll(GETRO_JOB_RE)) {
    const [, url, companySlug, jobId, titleSlug, rest] = m;
    const cleanCompany = companySlug
      .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
      .replace(/-\d+$/, '');
    const lastmod = (rest.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1] || '';
    rows.push({
      external_id: `getro:${company.slug}:${jobId}`,
      title: deslug(titleSlug),
      company: deslug(cleanCompany),
      location: '', // not in the sitemap — location filtering falls to the LLM CV-match
      url,
      updated: lastmod,
    });
  }
  return rows;
}

// Workday's list endpoint returns fuzzy "Posted N Days Ago" strings; exact dates live one
// call deeper (per-job detail) — not worth 400 extra calls. Fuzzy-to-ISO is fine for the
// freshness cut and repost baseline (day resolution).
export function workdayPostedToIso(postedOn, now = Date.now()) {
  const s = String(postedOn || '');
  if (/today/i.test(s)) return new Date(now).toISOString();
  if (/yesterday/i.test(s)) return new Date(now - 86400_000).toISOString();
  const m = s.match(/(\d+)\+?\s*days?\s+ago/i);
  if (m) return new Date(now - Number(m[1]) * 86400_000).toISOString();
  return '';
}

// Workday: externalPath ends in `_<JR-id>` (with an optional `-N` location-dedup counter,
// verified live). Splitting on `_` keeps that suffix → a stable, unique per-posting id.
export function normalizeWorkday(json, company) {
  return (json?.jobPostings || []).map((p) => {
    const path = String(p.externalPath || '');
    const id = path.split('_').pop() || String(p.title || '');
    return {
      external_id: `workday:${company.slug}:${id}`,
      title: String(p.title || '').trim(),
      company: company.name || company.slug,
      location: p.locationsText || '',
      url: `https://${company.slug}.${company.wd}.myworkdayjobs.com/en-US/${company.site}${path}`,
      updated: workdayPostedToIso(p.postedOn),
    };
  });
}

export function normalizeAmazon(json, company) {
  return (json?.jobs || []).map((p) => ({
    external_id: `amazon:${company.slug}:${p.id_icims || p.id}`,
    title: String(p.title || '').trim(),
    company: company.name || 'Amazon',
    location: p.normalized_location || p.location || '',
    url: p.job_path ? `https://www.amazon.jobs${p.job_path}` : '',
    updated: (() => { const t = Date.parse(p.posted_date || ''); return Number.isFinite(t) ? new Date(t).toISOString() : ''; })(),
  }));
}

export function normalizeSmartRecruiters(json, company) {
  return (json?.content || []).map((p) => ({
    external_id: `smartrecruiters:${company.slug}:${p.id}`,
    title: String(p.name || '').trim(),
    company: company.name || company.slug,
    location: [p.location?.city, p.location?.country].filter(Boolean).join(', '),
    url: `https://jobs.smartrecruiters.com/${company.slug}/${p.id}`,
    updated: p.releasedDate || '',
  }));
}

// Drushim's CityEnglish values arrive padded with tabs/whitespace in the live feed — trim them.
// Job URLs REQUIRE a hash segment (/job/<Code>/<hash>/); the bare /job/<Code>/ form 302s to the
// homepage. Prefer the ready-made relative JobInfo.Link, fall back to Code + JobInfo.Hash, and if
// neither is available emit '' — the pipeline drops empty-URL rows rather than send a dead link.
export function normalizeDrushim(json, company) {
  return (json?.ResultList || []).map((p) => {
    let url = '';
    if (p.JobInfo?.Link) url = `https://www.drushim.co.il${p.JobInfo.Link}`;
    else if (p.Code && p.JobInfo?.Hash) url = `https://www.drushim.co.il/job/${p.Code}/${String(p.JobInfo.Hash).toLowerCase()}/`;
    return {
      external_id: `drushim:${company.slug}:${p.Code || p.JobInfo?.JobId || String(p.JobContent?.Name || '')}`,
      title: String(p.JobContent?.Name || '').trim(),
      company: String(p.Company?.CompanyDisplayName || '').trim(),
      location: (p.JobContent?.Addresses || []).map((a) => String(a.CityEnglish || a.City || '').trim()).filter(Boolean).join(', '),
      url,
      updated: p.JobInfo?.Date || '',
    };
  });
}

export const normalizers = {
  comeet: normalizeComeet,
  greenhouse: normalizeGreenhouse,
  lever: normalizeLever,
  'lever-eu': (json, company) => normalizeLever(json, company).map((r) => ({ ...r, external_id: r.external_id.replace(/^lever:/, 'lever-eu:') })),
  ashby: normalizeAshby,
  bamboohr: normalizeBamboo,
  getro: normalizeGetro,
  workday: normalizeWorkday,
  amazon: normalizeAmazon,
  smartrecruiters: normalizeSmartRecruiters,
  drushim: normalizeDrushim,
};

// ---- Watchlist + freshness --------------------------------------------------------------

// Validate + filter a watchlist's companies: known ats, has slug, comeet also needs uid.
// Returns { companies, invalid } — invalid entries are reported, never silently dropped.
export function validateWatchlist(json) {
  const companies = [];
  const invalid = [];
  for (const c of json?.companies || []) {
    const ok = c && SUPPORTED_ATS.includes(c.ats) && c.slug
      && (c.ats !== 'comeet' || c.uid)
      && (c.ats !== 'workday' || (c.wd && c.site));
    (ok ? companies : invalid).push(c);
  }
  return { companies, invalid };
}

// ATS boards keep zombie postings alive for months. A position only becomes a candidate if
// its `updated` stamp is within `days` (positions with NO stamp pass — we can't judge them;
// the prompt-scout Step 2 recency backstop still applies).
export function freshEnough(updated, days, now = Date.now()) {
  if (!updated) return true;
  const t = Date.parse(updated);
  if (!Number.isFinite(t)) return true;
  return now - t <= days * 86400_000;
}

// Cap the seen-ledger like linkedin.mjs does (newest kept — ids are appended in run order).
export function pruneSeenIds(ids, max = 10000) {
  const uniq = [...new Set(ids)];
  return uniq.length > max ? uniq.slice(uniq.length - max) : uniq;
}

// Global companies' ATS boards mix every region; the shared location filter is Israel-centric
// and FAIL-OPEN on unknown locations (right for Israeli boards, floods here — e.g. Algosec
// India, VAST's US sales roles). This is the ATS-source pre-filter: a clearly-foreign
// country/hub token with NO Israel signal → drop. Heuristic only — the person's own
// allow/block filter and the LLM CV-match still run after it.
const FOREIGN_TOKEN =
  /\b(india|usa|u\.s\.|united states|uk\b|united kingdom|germany|france|poland|ukraine|romania|portugal|spain|netherlands|canada|australia|singapore|japan|china|brazil|mexico|austria|switzerland|czech|bulgaria|serbia|greece|cyprus|ireland|sweden|norway|denmark|finland|estonia|latvia|lithuania|hungary|slovakia|belgium|italy|turkey|uae|dubai|bangalore|bengaluru|pune|hyderabad|mumbai|delhi|chennai|london|berlin|munich|paris|warsaw|krakow|lisbon|madrid|barcelona|amsterdam|dublin|toronto|vancouver|montreal|new york|nyc|boston|austin|denver|seattle|chicago|atlanta|dallas|houston|miami|phoenix|raleigh|durham|remote[ -]?(us|usa|emea|europe|apac|latam))\b/i;
const ISRAEL_TOKEN = /israel|tel.?aviv|ישראל|תל.?אביב/i;

export function foreignLocation(text) {
  const t = String(text || '');
  return FOREIGN_TOKEN.test(t) && !ISRAEL_TOKEN.test(t);
}

// A known posting whose date stamp jumped forward >= minDays is a REPOST (company re-opened /
// re-published the role) — it should re-enter the pipeline flagged repost:true instead of being
// seen-dropped forever (David 2026-07-15: reposted roles are re-application opportunities).
// Small forward drift (< minDays) is treated as an in-place edit, not a repost.
export function isRepost(prevUpdated, curUpdated, minDays = 21) {
  const a = Date.parse(prevUpdated || '');
  const b = Date.parse(curUpdated || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return b - a >= minDays * 86400_000;
}
