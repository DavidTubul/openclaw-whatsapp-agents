// shared/tools/listen-export.test.mjs
//
// Tests for the PURE transform in shared/tools/listen-export.mjs — the mapping from a v3 session
// transcript line to a chat-log entry. The incremental/offset/rotation plumbing is exercised in
// production; here we lock the transform's contract: type/role/text filtering, owner vs non-owner
// mapping, string vs array content, and ts preference (inner epoch ms over outer ISO).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sessionLineToEntry, extractText, digitsOnly, extractSessionMedia, archiveEntryMedia,
} from './listen-export.mjs';

const line = (over = {}) => ({
  type: 'message',
  id: 'x',
  timestamp: '2026-07-14T12:42:06.514Z',
  message: {
    role: 'user',
    content: 'hi',
    timestamp: 1784032924000,
    __openclaw: { senderIsOwner: false, senderId: '+972500000009', senderName: 'Gilad' },
    ...over.message,
  },
  ...over.top,
});

test('non-owner: from=digits, speaker=name, ts from inner epoch ms', () => {
  const e = sessionLineToEntry(line());
  assert.deepEqual(e, {
    ts: new Date(1784032924000).toISOString(),
    from: '972500000009',
    speaker: 'Gilad',
    text: 'hi',
  });
});

test('owner via senderIsOwner -> david/David', () => {
  const e = sessionLineToEntry(line({ message: { __openclaw: { senderIsOwner: true, senderId: '+972500000009', senderName: 'Gilad' } } }));
  assert.equal(e.from, 'david');
  assert.equal(e.speaker, 'David');
});

test('owner via matching owner number -> david/David', () => {
  const e = sessionLineToEntry(line({ message: { __openclaw: { senderIsOwner: false, senderId: '+972-50-000-0001', senderName: 'David T' } } }), { ownerNumber: '972500000001' });
  assert.equal(e.from, 'david');
  assert.equal(e.speaker, 'David');
});

test('array content: text parts joined', () => {
  const e = sessionLineToEntry(line({ message: { content: [{ type: 'text', text: 'foo ' }, { type: 'image' }, { type: 'text', text: 'bar' }] } }));
  assert.equal(e.text, 'foo bar');
});

test('empty / whitespace-only content -> null (skipped)', () => {
  assert.equal(sessionLineToEntry(line({ message: { content: '   ' } })), null);
  assert.equal(sessionLineToEntry(line({ message: { content: [] } })), null);
  assert.equal(sessionLineToEntry(line({ message: { content: [{ type: 'image' }] } })), null);
});

test('non-message / non-user lines -> null', () => {
  assert.equal(sessionLineToEntry({ type: 'session', version: 3 }), null);
  assert.equal(sessionLineToEntry(line({ message: { role: 'assistant' } })), null);
  assert.equal(sessionLineToEntry(null), null);
});

test('ts falls back to outer ISO when inner timestamp is absent', () => {
  const e = sessionLineToEntry(line({ message: { timestamp: undefined } }));
  assert.equal(e.ts, '2026-07-14T12:42:06.514Z');
});

test('non-owner with no senderId falls back to senderName', () => {
  const e = sessionLineToEntry(line({ message: { __openclaw: { senderIsOwner: false, senderName: 'Yotam' } } }));
  assert.equal(e.from, 'Yotam');
  assert.equal(e.speaker, 'Yotam');
});

test('helpers: digitsOnly + extractText', () => {
  assert.equal(digitsOnly('+972 50-920'), '97250920');
  assert.equal(digitsOnly(undefined), '');
  assert.equal(extractText('  x  '), 'x');
  assert.equal(extractText([{ text: 'a' }, { text: 'b' }]), 'ab');
});

// ── media support ────────────────────────────────────────────────────────────────────────────────

test('extractSessionMedia: capitalized MediaPath(s)/MediaType(s)', () => {
  assert.deepEqual(extractSessionMedia({ MediaPath: '/s/a.ogg', MediaType: 'audio/ogg' }),
    [{ path: '/s/a.ogg', type: 'audio/ogg' }]);
  const m = extractSessionMedia({ MediaPaths: ['/s/a.jpg', '/s/b.pdf'], MediaTypes: ['image/jpeg', 'application/pdf'] });
  assert.equal(m.length, 2);
  assert.equal(m[1].path, '/s/b.pdf');
  assert.equal(m[1].type, 'application/pdf');
  assert.deepEqual(extractSessionMedia({}), []);
});

test('sessionLineToEntry: media-only line (<media:x> placeholder) → Hebrew placeholder + raw media', () => {
  const e = sessionLineToEntry(line({ message: {
    content: '<media:audio>', MediaPath: '/staged/v.ogg', MediaType: 'audio/ogg',
  } }));
  assert.equal(e.text, '[הקלטה קולית]');
  assert.equal(e.from, '972500000009');
  assert.equal(e.media.length, 1);
  assert.equal(e.media[0].path, '/staged/v.ogg');
});

test('sessionLineToEntry: caption + media keeps the caption', () => {
  const e = sessionLineToEntry(line({ message: {
    content: 'תראו את זה', MediaPath: '/staged/p.jpg', MediaType: 'image/jpeg',
  } }));
  assert.equal(e.text, 'תראו את זה');
  assert.equal(e.media.length, 1);
});

test('sessionLineToEntry: no text and no media → null (unchanged)', () => {
  assert.equal(sessionLineToEntry(line({ message: { content: '   ' } })), null);
});

test('archiveEntryMedia: copies staged file into data/media/<group>/, rewrites refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'le-media-'));
  const stagedDir = join(dir, 'staged');
  const wsDir = join(dir, 'ws');
  const mediaDir = join(wsDir, 'data', 'media');
  const src = join(stagedDir, 'note.ogg');
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(src, 'OGGDATA');
  const entry = { ts: '2026-07-14T12:00:00.000Z', from: 'x', speaker: 'x', text: '[הקלטה קולית]', media: [{ path: src, type: 'audio/ogg' }] };
  archiveEntryMedia(entry, { mediaDir, workspaceDir: wsDir, groupJid: 'G@g.us' });
  assert.equal(entry.media.length, 1);
  assert.equal(entry.media[0].archived, true);
  assert.equal(entry.media[0].mimetype, 'audio/ogg');
  assert.match(entry.media[0].archivedPath, /^data\/media\/G@g\.us\//);
  const copied = readFileSync(join(wsDir, entry.media[0].archivedPath), 'utf8');
  assert.equal(copied, 'OGGDATA');
  rmSync(dir, { recursive: true, force: true });
});

test('archiveEntryMedia: missing source → archived:false, still referenced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'le-media2-'));
  const entry = { ts: '2026-07-14T12:00:00.000Z', media: [{ path: join(dir, 'gone.ogg'), type: 'audio/ogg' }] };
  archiveEntryMedia(entry, { mediaDir: join(dir, 'm'), workspaceDir: dir, groupJid: 'G@g.us' });
  assert.equal(entry.media[0].archived, false);
  assert.equal(entry.media[0].archivedPath, null);
  assert.equal(entry.media[0].originalName, 'gone.ogg');
  assert.equal(existsSync(join(dir, 'm')), false); // nothing copied
  rmSync(dir, { recursive: true, force: true });
});
