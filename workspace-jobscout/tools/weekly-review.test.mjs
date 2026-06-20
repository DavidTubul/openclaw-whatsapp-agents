import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRows, classifyStatus, splitSources, scoreBucket } from './weekly-review.mjs';

test('classifyStatus maps emoji + text statuses to outcome classes', () => {
  assert.equal(classifyStatus('📞 Interview'), 'win');
  assert.equal(classifyStatus('🎉 Offer'), 'win');
  assert.equal(classifyStatus('✅ Applied'), 'applied');
  assert.equal(classifyStatus('❌ Rejected'), 'rejected');
  assert.equal(classifyStatus('⛔ Not Interested'), 'noise');
  assert.equal(classifyStatus('⏳ Pending'), 'pending');
  assert.equal(classifyStatus(''), 'pending'); // default
  assert.equal(classifyStatus(undefined), 'pending');
});

test('splitSources credits each source and drops the channel suffix', () => {
  assert.deepEqual(splitSources('linkedin + telegram:IL_QA_Job'), ['linkedin', 'telegram']);
  assert.deepEqual(splitSources('LinkedIn'), ['linkedin']);
  assert.deepEqual(splitSources('tavily, indeed'), ['tavily', 'indeed']);
  assert.deepEqual(splitSources(''), []);
});

test('scoreBucket bands scores; non-numeric -> unknown', () => {
  assert.equal(scoreBucket(95), '90+');
  assert.equal(scoreBucket(80), '80-89');
  assert.equal(scoreBucket(70), '70-79');
  assert.equal(scoreBucket(55), '<70');
  assert.equal(scoreBucket('abc'), 'unknown');
});

test('analyzeRows builds the outcome funnel and per-dimension rates', () => {
  const rows = [
    { source: 'linkedin', level: 'mid', score: 80, status: '📞 Interview', title: 'QA', company: 'A', reason: 'good' },
    { source: 'linkedin', level: 'mid', score: 78, status: '✅ Applied', title: 'SDET', company: 'B' },
    { source: 'tavily', level: 'senior', score: 65, status: '⛔ Not Interested', title: 'GTM', company: 'C' },
    { source: 'linkedin + telegram:IL_QA_Job', level: 'senior', score: 90, status: '🎉 Offer', title: 'Auto', company: 'D', reason: 'win' },
    { source: 'tavily', level: 'mid', score: 72, status: '⏳ Pending', title: 'QA2', company: 'E' },
  ];
  const r = analyzeRows(rows);

  assert.equal(r.total, 5);
  assert.deepEqual(r.by_status, { total: 5, win: 2, applied: 1, rejected: 0, noise: 1, pending: 1 });

  // linkedin appears in 3 rows (incl. the combined source); all engaged, 0 noise.
  assert.equal(r.by_source.linkedin.total, 3);
  assert.equal(r.by_source.linkedin.engaged, 3);
  assert.equal(r.by_source.linkedin.noise_rate, 0);
  // telegram credited once (from the combined source), a win.
  assert.equal(r.by_source.telegram.total, 1);
  assert.equal(r.by_source.telegram.win, 1);
  // tavily: 1 noise + 1 pending -> 50% noise, 0% engaged.
  assert.equal(r.by_source.tavily.total, 2);
  assert.equal(r.by_source.tavily.noise_rate, 50);
  assert.equal(r.by_source.tavily.engagement_rate, 0);

  assert.equal(r.wins.length, 2);
  assert.equal(r.noise.length, 1);
  assert.equal(r.noise[0].company, 'C');
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].company, 'B');

  assert.equal(r.by_score_bucket['80-89'].win, 1);
  assert.equal(r.by_score_bucket['90+'].win, 1);
  assert.equal(r.by_score_bucket['<70'].noise, 1);
});

test('analyzeRows tolerates empty / non-array input', () => {
  assert.equal(analyzeRows([]).total, 0);
  assert.equal(analyzeRows(undefined).total, 0);
  assert.equal(analyzeRows(null).total, 0);
});
