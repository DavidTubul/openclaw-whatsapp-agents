import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayInTz, timeInTz, partsInTz, displayInTz, stampInTz } from './time.mjs';

test('todayInTz: Israel is a day AHEAD of UTC late at night (the zorro off-by-one bug)', () => {
  // 2026-07-01 23:30 UTC = 2026-07-02 02:30 Asia/Jerusalem (IDT, UTC+3)
  const d = new Date('2026-07-01T23:30:00Z');
  assert.equal(todayInTz('Asia/Jerusalem', d), '2026-07-02');
  assert.equal(d.toISOString().slice(0, 10), '2026-07-01'); // what the old UTC code returned
});

test('todayInTz: shape is YYYY-MM-DD', () => {
  assert.match(todayInTz(), /^\d{4}-\d{2}-\d{2}$/);
});

test('timeInTz: HH:MM 24h in the tz', () => {
  const d = new Date('2026-07-01T23:30:00Z');
  assert.equal(timeInTz('Asia/Jerusalem', d), '02:30');
});

test('partsInTz: Israel is a day AHEAD of UTC late at night (decomposed date+hh+mm)', () => {
  // 2026-07-01 23:30 UTC = 2026-07-02 02:30 Asia/Jerusalem (IDT, UTC+3)
  const d = new Date('2026-07-01T23:30:00Z');
  assert.deepEqual(partsInTz(d, 'Asia/Jerusalem'), { date: '2026-07-02', hh: 2, mm: 30 });
});

test('partsInTz: default tz is Asia/Jerusalem and shape is well-formed', () => {
  const p = partsInTz();
  assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isInteger(p.hh) && p.hh >= 0 && p.hh <= 23);
  assert.ok(Number.isInteger(p.mm) && p.mm >= 0 && p.mm <= 59);
});

test('stampInTz: YYYYMMDD-HHMMSS in Israel wall-clock, a day ahead of UTC late at night', () => {
  // 2026-07-01 23:30:15 UTC = 2026-07-02 02:30:15 Asia/Jerusalem
  const d = new Date('2026-07-01T23:30:15Z');
  assert.equal(stampInTz(d, 'Asia/Jerusalem'), '20260702-023015');
  assert.equal(stampInTz(d), '20260702-023015'); // default tz
});

test('stampInTz: midnight Israel renders hour 00 (h23), not 24', () => {
  // 2026-01-01 22:00:00 UTC = 2026-01-02 00:00:00 Asia/Jerusalem (IST, UTC+2)
  const d = new Date('2026-01-01T22:00:00Z');
  assert.equal(stampInTz(d, 'Asia/Jerusalem'), '20260102-000000');
});

test('displayInTz: he-IL short date+time in the tz (a day ahead late at night)', () => {
  const d = new Date('2026-07-01T23:30:00Z'); // 02:30 on 2/7 in Israel
  const s = displayInTz(d, { tz: 'Asia/Jerusalem' });
  // he-IL short: dd.mm.yyyy, hh:mm — assert the Israel date/time landed, not the UTC one.
  assert.ok(s.includes('2.7.2026') || s.includes('02.07.2026'), `got: ${s}`);
  assert.ok(s.includes('2:30') || s.includes('02:30'), `got: ${s}`);
});

test('displayInTz: extra opts override the short/short defaults', () => {
  const d = new Date('2026-07-01T23:30:00Z');
  const s = displayInTz(d, { locale: 'en-US', tz: 'Asia/Jerusalem', dateStyle: undefined, timeStyle: 'medium' });
  assert.match(s, /2:30:00/); // time-only, seconds shown
});
