import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl, canonicalJobUrl, parseCards, incrementalWindowSeconds,
  BACKFILL_WINDOW, FRESH_WINDOW, isClosedHtml, filterNewCandidates, pruneSeen,
  titleSignalsAutomation, jdSignalsAutomation, titleHardExcluded,
  resolveScanWindow, vetVerdict,
} from './linkedin.mjs';

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
});

test('FRESH_WINDOW caps the backfill window to ~1 week (last-week rule)', () => {
  assert.equal(FRESH_WINDOW, 604800);
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
  assert.equal(vetVerdict({ title: 'x', html: 'No longer accepting applications', automationVet: true }).keep, false);
});

test('vetVerdict[David, automationVet on]: manual-QA JD dropped, automation JD kept', () => {
  assert.deepEqual(vetVerdict({ title: 'QA Engineer', html: 'manual test cases only', automationVet: true }), { keep: false, why: 'manual-only' });
  assert.equal(vetVerdict({ title: 'QA Engineer', html: 'build selenium frameworks', automationVet: true }).keep, true);
});

test('vetVerdict[non-QA, automationVet off]: TPM/Delivery JD with no automation is KEPT (the the guest fix)', () => {
  // With automationVet ON this would be manual-only=drop — the second bug layer that nuked the guest.
  assert.equal(vetVerdict({ title: 'Technical Program Manager', html: 'lead cross-functional programs', automationVet: false }).keep, true);
  assert.equal(vetVerdict({ title: 'VP Delivery', html: 'own the delivery roadmap', automationVet: false }).keep, true);
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
  });
  assert.equal(cards[1].id, '4418983486');
  assert.equal(cards[1].title, 'QA Automation Team Leader & SDET');
  assert.equal(cards[1].company, 'SolarEdge');
  assert.equal(cards[1].location, 'Ramat Gan, Tel Aviv District, Israel');
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
