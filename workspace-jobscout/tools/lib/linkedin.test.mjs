import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl, canonicalJobUrl, parseCards, incrementalWindowSeconds,
  BACKFILL_WINDOW, FRESH_WINDOW, isClosedHtml, filterNewCandidates, pruneSeen,
  titleSignalsAutomation, jdSignalsAutomation, titleHardExcluded,
  resolveScanWindow, vetVerdict, looksLikeJobPage, companyIsJuniorExempt,
  extractDatePosted,
} from './linkedin.mjs';

// A minimal REAL job-view page: carries the posting-body markers looksLikeJobPage keys off,
// so the closed/manual-only vets actually run on it. `body` is the JD text under test.
const jobPage = (body = '') =>
  `<div class="top-card-layout__title">Some Role</div>` +
  `<div class="show-more-less-html"><div class="description__text">${body}</div></div>`;
// A rate-limit / login wall: non-empty, no posting-body markers (this is what starved recall).
const AUTHWALL = '<html><body><div class="authwall">Join LinkedIn — sign in to view this job</div>'
  + ' <a href="/checkpoint/lg/login">Sign in</a></body></html>';

test('buildSearchUrl encodes keyword, location, window, start', () => {
  const url = buildSearchUrl({ keyword: 'QA Automation', location: 'Israel', tprSeconds: 604800, start: 25 });
  assert.ok(url.startsWith('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?'));
  assert.match(url, /keywords=QA(\+|%20)Automation/);
  assert.match(url, /location=Israel/);
  assert.match(url, /f_TPR=r604800/);
  assert.match(url, /start=25/);
});

test('buildSearchUrl floors fractional seconds', () => {
  const url = buildSearchUrl({ keyword: 'x', location: 'Israel', tprSeconds: 86400.9, start: 0 });
  assert.match(url, /f_TPR=r86400/);
});

test('buildSearchUrl sorts by date (DD), not relevance', () => {
  const url = buildSearchUrl({ keyword: 'QA', location: 'Israel', tprSeconds: 604800, start: 0 });
  assert.match(url, /sortBy=DD/);
});

// David's full filter (IC QA/Automation): junior + management + off-field-by-QA-signal.
const DAVID = { junior: true, management: true, off_field: 'qa' };

test('titleHardExcluded[David]: off-field titles (no QA/test/automation signal) → dropped', () => {
  // the cases David flagged + the dev-role leakers seen in a live run
  assert.equal(titleHardExcluded('GTM Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Sales Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Solutions Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Data Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Senior Frontend Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Machine Learning Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Senior Software Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Senior C++ Software Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Senior Software Golang Kubernetes Engineer', DAVID), 'off-field');
  assert.equal(titleHardExcluded('Network Engineer', DAVID), 'off-field');
});

test('titleHardExcluded[David]: junior / management → dropped', () => {
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', DAVID), 'junior');
  assert.equal(titleHardExcluded('QA Automation Engineer (Junior level)', DAVID), 'junior');
  assert.equal(titleHardExcluded('Automation Team Lead', DAVID), 'management');
  assert.equal(titleHardExcluded('Head of QA', DAVID), 'management');
  assert.equal(titleHardExcluded('QA Manager', DAVID), 'management');
});

test('titleHardExcluded[David]: real IC QA/automation titles → kept (empty)', () => {
  assert.equal(titleHardExcluded('Senior Automation Engineer', DAVID), '');
  assert.equal(titleHardExcluded('QA Automation Engineer', DAVID), '');
  assert.equal(titleHardExcluded('SDET', DAVID), '');
  assert.equal(titleHardExcluded('Senior QA Engineer', DAVID), '');
  assert.equal(titleHardExcluded('Software Engineer in Test', DAVID), '');
  assert.equal(titleHardExcluded('Senior Software Engineer in Test (SET)', DAVID), '');
  assert.equal(titleHardExcluded('Verification Engineer', DAVID), '');
  assert.equal(titleHardExcluded('QA/RA Engineer', DAVID), '');
  // in-field signal protects against a stray off-field word match
  assert.equal(titleHardExcluded('QA Automation Engineer - Data Platform', DAVID), '');
  assert.equal(titleHardExcluded('DevOps Automation Engineer', DAVID), '');
});

test('titleHardExcluded[default/no filter]: nothing is hard-dropped (rely on CV-match)', () => {
  // The regression that motivated this: a bare call must NOT nuke a non-QA profile.
  assert.equal(titleHardExcluded('GTM Engineer'), '');
  assert.equal(titleHardExcluded('VP Delivery'), '');
  assert.equal(titleHardExcluded('Junior Program Manager'), '');
  assert.equal(titleHardExcluded('Technical Program Manager', {}), '');
});

test('titleHardExcluded[the guest: junior-only]: keeps PM + management, drops only junior', () => {
  const RANI = { junior: true };  // TPM/PM person: wants senior IC *and* management
  assert.equal(titleHardExcluded('Technical Program Manager', RANI), '');   // off-field NOT applied
  assert.equal(titleHardExcluded('VP Delivery', RANI), '');                 // management NOT applied
  assert.equal(titleHardExcluded('Head of PMO', RANI), '');                 // management NOT applied
  assert.equal(titleHardExcluded('Senior Program Manager', RANI), '');
  assert.equal(titleHardExcluded('Junior Program Manager', RANI), 'junior'); // junior still dropped
  // no junior_exempt_big_companies key → old behavior even when a company IS passed
  assert.equal(titleHardExcluded('Junior Program Manager', RANI, 'Microsoft'), 'junior');
});

// David's filter WITH the big-company junior exemption (2026-07-13 policy).
const DAVID_EXEMPT = {
  ...DAVID,
  junior_exempt_big_companies: ['Microsoft', 'Google', 'NVIDIA', 'Check Point', 'Wix', 'Via', 'Monday'],
};

test('titleHardExcluded[junior exemption]: junior at a BIG company → KEPT; unknown startup → dropped', () => {
  // the policy: "בחברות גדולות מבחינתי זה בסדר גם משרות ג'וניור"
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', DAVID_EXEMPT, 'Microsoft'), '');
  assert.equal(titleHardExcluded('Junior QA Engineer', DAVID_EXEMPT, 'Microsoft Israel R&D'), ''); // suffix-tolerant
  assert.equal(titleHardExcluded('QA Engineer (Entry Level)', DAVID_EXEMPT, 'Google'), '');
  assert.equal(titleHardExcluded('Junior Test Automation Engineer', DAVID_EXEMPT, 'Check Point Software Technologies'), '');
  // NOT exempt: unknown startup / empty company / no match → still hard-dropped
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', DAVID_EXEMPT, 'StealthStartup Ltd'), 'junior');
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', DAVID_EXEMPT, ''), 'junior');
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', DAVID_EXEMPT), 'junior');
});

test('titleHardExcluded[junior exemption]: internships ALWAYS dropped, even at a big company', () => {
  assert.equal(titleHardExcluded('QA Intern', DAVID_EXEMPT, 'Microsoft'), 'internship');
  assert.equal(titleHardExcluded('Software Testing Internship', DAVID_EXEMPT, 'Google'), 'internship');
  assert.equal(titleHardExcluded('Student QA Position', DAVID_EXEMPT, 'NVIDIA'), 'internship');
  assert.equal(titleHardExcluded('QA Trainee', DAVID_EXEMPT, 'Check Point'), 'internship');
});

test('titleHardExcluded[junior exemption]: non-junior buckets unaffected by company', () => {
  assert.equal(titleHardExcluded('QA Manager', DAVID_EXEMPT, 'Microsoft'), 'management');
  assert.equal(titleHardExcluded('GTM Engineer', DAVID_EXEMPT, 'Microsoft'), 'off-field');
  assert.equal(titleHardExcluded('Senior QA Engineer', DAVID_EXEMPT, 'StealthStartup Ltd'), '');
});

test('companyIsJuniorExempt: word match, suffix-tolerant, case-insensitive, no substring bleed', () => {
  const list = ['Microsoft', 'Via', 'Monday', 'Check Point'];
  assert.equal(companyIsJuniorExempt('Microsoft', list), true);
  assert.equal(companyIsJuniorExempt('Microsoft Israel R&D', list), true);
  assert.equal(companyIsJuniorExempt('microsoft', list), true);
  assert.equal(companyIsJuniorExempt('Monday.com', list), true);       // dot boundary handled
  assert.equal(companyIsJuniorExempt('Check Point Software Technologies', list), true);
  assert.equal(companyIsJuniorExempt('Via Transportation', list), true);
  // NOT matches: substring inside another word, empty/absent inputs
  assert.equal(companyIsJuniorExempt('Aviva', list), false);            // "Via" must not fire inside a word
  assert.equal(companyIsJuniorExempt('Microsoftly Inc', list), false);
  assert.equal(companyIsJuniorExempt('SomeStartup', list), false);
  assert.equal(companyIsJuniorExempt('', list), false);
  assert.equal(companyIsJuniorExempt('Microsoft', []), false);
  assert.equal(companyIsJuniorExempt('Microsoft', null), false);
});

test('FRESH_WINDOW caps the backfill window to ~2 weeks (recency ceiling)', () => {
  assert.equal(FRESH_WINDOW, 14 * 86400); // widened 7→14d (2026-06-29) to close the deep-scan gap
  assert.equal(Math.min(BACKFILL_WINDOW, FRESH_WINDOW), FRESH_WINDOW);
});

const PAGES = { backfillMaxPages: 25, incrementalMaxPages: 10 };

test('resolveScanWindow: deep N-day scan bypasses FRESH_WINDOW cap + full sweep (the on-demand fix)', () => {
  const r = resolveScanWindow({ deepDays: 30, isBackfill: false, lastRun: '2026-06-07', today: '2026-06-08', ...PAGES });
  assert.equal(r.tprSeconds, 30 * 86400);      // 2592000 — NOT capped to 604800
  assert.ok(r.tprSeconds > FRESH_WINDOW);
  assert.equal(r.fullSweep, true);             // no early-stop
  assert.equal(r.maxPages, 25);
  assert.equal(r.deep, true);
});

test('resolveScanWindow: backfill → capped to FRESH_WINDOW, full sweep', () => {
  const r = resolveScanWindow({ deepDays: null, isBackfill: true, lastRun: null, today: '2026-06-08', ...PAGES });
  assert.equal(r.tprSeconds, FRESH_WINDOW);
  assert.equal(r.fullSweep, true);
  assert.equal(r.maxPages, 25);
  assert.equal(r.deep, false);
});

test('resolveScanWindow: incremental → capped, early-stop pages', () => {
  const r = resolveScanWindow({ deepDays: null, isBackfill: false, lastRun: '2026-06-07', today: '2026-06-08', ...PAGES });
  assert.ok(r.tprSeconds <= FRESH_WINDOW);
  assert.equal(r.fullSweep, false);
  assert.equal(r.maxPages, 10);
});

test('vetVerdict: fail-open on empty html; drop a closed posting', () => {
  assert.equal(vetVerdict({ title: 'x', html: '', automationVet: true }).keep, true);
  // closed check only fires on a REAL job page (marker present) that also says "No longer accepting"
  assert.equal(vetVerdict({ title: 'x', html: jobPage('No longer accepting applications'), automationVet: true }).keep, false);
  assert.equal(vetVerdict({ title: 'x', html: jobPage('No longer accepting applications'), automationVet: true }).why, 'closed');
});

test('vetVerdict: authwall / rate-limit wall (non-empty, not a job page) → KEEP why:unverifiable (recall fix)', () => {
  // THE regression under test: a wall page is non-empty and NOT "closed", but the old code let the
  // manual-only vet fire on it and silently dropped a real QA job forever. Now it fails OPEN.
  assert.deepEqual(vetVerdict({ title: 'QA Engineer', html: AUTHWALL, automationVet: true }), { keep: true, why: 'unverifiable' });
  assert.deepEqual(vetVerdict({ title: 'Automation Engineer', html: AUTHWALL, automationVet: true }), { keep: true, why: 'unverifiable' });
  // even a wall page that happens to contain the closed phrase is NOT a job page → still kept
  assert.equal(vetVerdict({ title: 'x', html: '<div class="authwall">No longer accepting applications</div>', automationVet: true }).why, 'unverifiable');
});

test('vetVerdict[David, automationVet on]: manual-QA JD dropped, automation JD kept (real job page)', () => {
  assert.deepEqual(vetVerdict({ title: 'QA Engineer', html: jobPage('manual test cases only'), automationVet: true }), { keep: false, why: 'manual-only' });
  assert.equal(vetVerdict({ title: 'QA Engineer', html: jobPage('build selenium frameworks'), automationVet: true }).keep, true);
});

test('vetVerdict[non-QA, automationVet off]: TPM/Delivery JD with no automation is KEPT (the the guest fix)', () => {
  // With automationVet ON this would be manual-only=drop — the second bug layer that nuked the guest.
  assert.equal(vetVerdict({ title: 'Technical Program Manager', html: jobPage('lead cross-functional programs'), automationVet: false }).keep, true);
  assert.equal(vetVerdict({ title: 'VP Delivery', html: jobPage('own the delivery roadmap'), automationVet: false }).keep, true);
});

test('looksLikeJobPage: real posting markers → true; walls/garbage/empty → false', () => {
  assert.equal(looksLikeJobPage(jobPage('anything')), true);
  assert.equal(looksLikeJobPage('<div class="show-more-less-html">x</div>'), true);
  assert.equal(looksLikeJobPage('<section class="description__text">x</section>'), true);
  assert.equal(looksLikeJobPage('{"@type":"JobPosting"}'), true);
  // walls / login / garbage / empty → NOT a job page (caller then fails open)
  assert.equal(looksLikeJobPage(AUTHWALL), false);
  assert.equal(looksLikeJobPage('<html><body>Sign in to LinkedIn</body></html>'), false);
  assert.equal(looksLikeJobPage(''), false);
  assert.equal(looksLikeJobPage(null), false);
  assert.equal(looksLikeJobPage(undefined), false);
});

test('canonicalJobUrl builds a stable view URL', () => {
  assert.equal(canonicalJobUrl('4418561672'), 'https://www.linkedin.com/jobs/view/4418561672');
});

const FIXTURE = `
<ul class="jobs-search__results-list">
<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:4418561672">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/automation-team-lead-at-algosec-4418561672"></a>
    <h3 class="base-search-card__title">
                Automation Team Lead, Israel
            </h3>
    <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://www.linkedin.com/company/algosec">AlgoSec</a>
    </h4>
    <span class="job-search-card__location">
                Petah Tikva, Center District, Israel
            </span>
    <time class="job-search-card__listdate" datetime="2026-07-12">3 days ago</time>
  </div>
</li>
<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:4418983486">
    <a class="base-card__full-link" href="#"></a>
    <h3 class="base-search-card__title">
                QA Automation Team Leader &amp; SDET
            </h3>
    <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="#">SolarEdge</a>
    </h4>
    <span class="job-search-card__location">
                Ramat Gan, Tel Aviv District, Israel
            </span>
  </div>
</li>
</ul>`;

test('parseCards extracts id/title/company/location and unescapes entities', () => {
  const cards = parseCards(FIXTURE);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    id: '4418561672',
    title: 'Automation Team Lead, Israel',
    company: 'AlgoSec',
    location: 'Petah Tikva, Center District, Israel',
    posted: '2026-07-12',           // pulled from the card's <time datetime="...">
  });
  assert.equal(cards[1].id, '4418983486');
  assert.equal(cards[1].title, 'QA Automation Team Leader & SDET');
  assert.equal(cards[1].company, 'SolarEdge');
  assert.equal(cards[1].location, 'Ramat Gan, Tel Aviv District, Israel');
  assert.equal(cards[1].posted, '');  // no <time> tag in this card → empty
});

test('parseCards returns [] for empty/garbage/nullish input', () => {
  assert.deepEqual(parseCards(''), []);
  assert.deepEqual(parseCards('<html>no jobs here</html>'), []);
  assert.deepEqual(parseCards(null), []);
  assert.deepEqual(parseCards(undefined), []);
});

test('window = (gap + 1 day) for a normal daily run', () => {
  // last run yesterday -> 2 days
  assert.equal(incrementalWindowSeconds('2026-05-29', '2026-05-30'), 2 * 86400);
});

test('window widens after a multi-day outage', () => {
  // 6 days gap -> 7 days
  assert.equal(incrementalWindowSeconds('2026-05-24', '2026-05-30'), 7 * 86400);
});

test('window is capped at 30 days', () => {
  assert.equal(incrementalWindowSeconds('2026-01-01', '2026-05-30'), BACKFILL_WINDOW);
});

test('same-day run still covers at least 1 day', () => {
  assert.equal(incrementalWindowSeconds('2026-05-30', '2026-05-30'), 1 * 86400);
});

test('missing/invalid last_run falls back to the cap', () => {
  assert.equal(incrementalWindowSeconds(null, '2026-05-30'), BACKFILL_WINDOW);
});

test('isClosedHtml detects closed postings (EN + HE)', () => {
  assert.equal(isClosedHtml('<div>No longer accepting applications</div>'), true);
  assert.equal(isClosedHtml('משרה זו אינה מקבלת עוד מועמדים'), true);
  assert.equal(isClosedHtml('we are not accepting applications'), true);
});

test('isClosedHtml returns false for an open posting', () => {
  assert.equal(isClosedHtml('<button>Apply now</button>'), false);
  assert.equal(isClosedHtml(''), false);
});

test('filterNewCandidates keeps only unseen ids', () => {
  const cands = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const fresh = filterNewCandidates(cands, ['2']);
  assert.deepEqual(fresh.map((c) => c.id), ['1', '3']);
});

test('filterNewCandidates accepts a Set and skips id-less items', () => {
  const fresh = filterNewCandidates([{ id: '1' }, {}, { id: '9' }], new Set(['9']));
  assert.deepEqual(fresh.map((c) => c.id), ['1']);
});

test('filterNewCandidates returns [] for nullish candidates', () => {
  assert.deepEqual(filterNewCandidates(null, ['1']), []);
  assert.deepEqual(filterNewCandidates(undefined, new Set()), []);
});

test('pruneSeen dedupes and keeps the most recent max ids', () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(i));
  const pruned = pruneSeen([...ids, '0', '1'], 5);
  assert.equal(pruned.length, 5);
  assert.deepEqual(pruned, ['7', '8', '9', '10', '11']);
});

test('titleSignalsAutomation: clear automation titles → true', () => {
  assert.equal(titleSignalsAutomation('Senior Automation Engineer'), true);
  assert.equal(titleSignalsAutomation('SDET'), true);
  assert.equal(titleSignalsAutomation('Software Engineer - Test Automation'), true);
  assert.equal(titleSignalsAutomation('Software Verification Engineer'), true);
});

test('titleSignalsAutomation: ambiguous QA titles → false (need JD check)', () => {
  assert.equal(titleSignalsAutomation('QA Engineer'), false);
  assert.equal(titleSignalsAutomation('Quality Assurance Engineer'), false);
  assert.equal(titleSignalsAutomation('System Tester'), false);
  assert.equal(titleSignalsAutomation('Mobile QA Engineer'), false);
});

test('jdSignalsAutomation: JD mentioning automation tools → true', () => {
  assert.equal(jdSignalsAutomation('Build frameworks with Selenium and Playwright'), true);
  assert.equal(jdSignalsAutomation('Experience with test automation and CI'), true);
  assert.equal(jdSignalsAutomation('דרוש ניסיון באוטומציה'), true);
});

test('jdSignalsAutomation: pure-manual JD with no automation → false', () => {
  assert.equal(jdSignalsAutomation('Manual testing: write and execute test cases, report bugs.'), false);
  assert.equal(jdSignalsAutomation(''), false);
});

test('titleHardExcluded: internships flag drops interns but passes junior/mid/unspecified', () => {
  const f = { internships: true, management: true, off_field: 'qa' }; // David's new filter
  assert.equal(titleHardExcluded('QA Automation Intern', f, 'SomeStartup'), 'internship');
  assert.equal(titleHardExcluded('סטודנט לבדיקות תוכנה', f, 'SomeStartup'), 'internship');
  assert.equal(titleHardExcluded('Junior QA Automation Engineer', f, 'SomeStartup'), '');
  assert.equal(titleHardExcluded('QA Automation Engineer', f, 'SomeStartup'), '');
  assert.equal(titleHardExcluded('QA Team Lead', f, 'SomeStartup'), 'management');
});

test('titleHardExcluded: legacy junior:true still drops interns (guests unchanged)', () => {
  const f = { junior: true };
  assert.equal(titleHardExcluded('Software Intern', f, 'Anywhere'), 'internship');
  assert.equal(titleHardExcluded('Junior Analyst', f, 'Anywhere'), 'junior');
});

// The Tavily source (search.mjs) now applies this same pre-filter. Regression for Bug 2
// (2026-07-15): a pure-DevOps title reached David because search.mjs had no title filter.
test('titleHardExcluded: search.mjs pre-filter — DevOps-only dropped, QA/Automation kept', () => {
  const f = { internships: true, management: true, off_field: 'qa' }; // David's live filter
  assert.equal(titleHardExcluded('DevOps Engineer', f, 'Harmony'), 'off-field'); // Bug 2 exact case
  assert.equal(titleHardExcluded('Senior DevOps Engineer', f, 'Harmony'), 'off-field');
  assert.equal(titleHardExcluded('QA Automation Engineer', f, 'Harmony'), '');    // in-field passes
  assert.equal(titleHardExcluded('DevOps Automation Engineer', f, 'Harmony'), ''); // automation signal keeps it
});

test('extractDatePosted: pulls JSON-LD datePosted, tolerant of garbage', () => {
  assert.equal(extractDatePosted('...{"@type":"JobPosting","datePosted":"2026-07-12T08:00:00.000Z"}...'), '2026-07-12');
  assert.equal(extractDatePosted('<html>no ld+json here</html>'), '');
  assert.equal(extractDatePosted(''), '');
});
