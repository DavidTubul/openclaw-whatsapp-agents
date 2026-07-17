// shared/tools/transcribe-media.test.mjs
//
// Tests the queue-scan + transcribe orchestration with a MOCKED backend (no real whisper). Covers:
//   - isAudioFile / needsTranscription sidecar detection
//   - scanWorkspace finds pending audio, skips files that already have a .transcript.txt / .err
//   - transcribeOne writes the sidecar + appends the transcript chat-log entry (reflect-ingestible)
//   - a per-file backend error drops a .transcript.err and does NOT append
//   - an "unavailable" backend leaves the file queued (no sidecar, no append)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAudioFile, needsTranscription, scanWorkspace, transcribeOne,
  transcriptPathFor, errorPathFor, AUDIO_EXTS,
} from './transcribe-media.mjs';

function makeWorkspace(files) {
  // files: { '<groupJid>': ['a.ogg', 'b.jpg', ...] }
  const ws = mkdtempSync(join(tmpdir(), 'tm-ws-'));
  for (const [group, names] of Object.entries(files)) {
    const gdir = join(ws, 'data', 'media', group);
    mkdirSync(gdir, { recursive: true });
    for (const n of names) writeFileSync(join(gdir, n), `AUDIO:${n}`);
  }
  mkdirSync(join(ws, 'data', 'chat-log'), { recursive: true });
  return ws;
}

test('isAudioFile: audio yes, images/transcripts no', () => {
  assert.ok(isAudioFile('x.ogg'));
  assert.ok(isAudioFile('voice.OPUS'));
  assert.ok(AUDIO_EXTS.has('m4a'));
  assert.equal(isAudioFile('x.jpg'), false);
  assert.equal(isAudioFile('x.ogg.transcript.txt'), false);
  assert.equal(isAudioFile('x.ogg.transcript.err'), false);
});

test('scanWorkspace: finds pending audio only, skips already-transcribed + non-audio', () => {
  const ws = makeWorkspace({ 'G1@g.us': ['a.ogg', 'b.opus', 'pic.jpg'], 'G2@g.us': ['c.m4a'] });
  // mark a.ogg as already done
  writeFileSync(transcriptPathFor(join(ws, 'data', 'media', 'G1@g.us', 'a.ogg')), 'hi\n');
  const q = scanWorkspace(ws);
  const names = q.map((x) => x.file.split('/').pop()).sort();
  assert.deepEqual(names, ['b.opus', 'c.m4a']);
  const g2 = q.find((x) => x.groupJid === 'G2@g.us');
  assert.equal(g2.jsonlPath, join(ws, 'data', 'chat-log', 'G2@g.us.jsonl'));
  assert.equal(needsTranscription(join(ws, 'data', 'media', 'G1@g.us', 'a.ogg')), false);
  rmSync(ws, { recursive: true, force: true });
});

test('transcribeOne: writes sidecar + appends reflect-ingestible transcript entry', () => {
  const ws = makeWorkspace({ 'G@g.us': ['note.ogg'] });
  const item = scanWorkspace(ws)[0];
  const backend = () => ({ ok: true, text: 'שלום זה תמלול' });
  const r = transcribeOne(item, backend);
  assert.equal(r.ok, true);

  const sidecar = readFileSync(transcriptPathFor(item.file), 'utf8').trim();
  assert.equal(sidecar, 'שלום זה תמלול');

  const jsonl = readFileSync(item.jsonlPath, 'utf8').trim();
  const entry = JSON.parse(jsonl);
  assert.equal(entry.type, 'transcript');
  assert.equal(entry.refMessageId, 'note.ogg');
  assert.match(entry.text, /שלום זה תמלול/);
  assert.ok(entry.text.includes('תמלול')); // Hebrew marker so reflect ingests it as speech
  assert.equal(entry.speaker, 'תמלול');
  rmSync(ws, { recursive: true, force: true });
});

test('transcribeOne: empty transcript writes sidecar but appends nothing', () => {
  const ws = makeWorkspace({ 'G@g.us': ['silent.ogg'] });
  const item = scanWorkspace(ws)[0];
  const r = transcribeOne(item, () => ({ ok: true, text: '   ' }));
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
  assert.ok(existsSync(transcriptPathFor(item.file)));   // sidecar written (don't retry)
  assert.equal(existsSync(item.jsonlPath), false);       // nothing appended
  rmSync(ws, { recursive: true, force: true });
});

test('transcribeOne: per-file error drops .err marker, no append', () => {
  const ws = makeWorkspace({ 'G@g.us': ['bad.ogg'] });
  const item = scanWorkspace(ws)[0];
  const r = transcribeOne(item, () => ({ ok: false, error: 'corrupt' }));
  assert.equal(r.ok, false);
  assert.ok(existsSync(errorPathFor(item.file)));
  assert.equal(existsSync(item.jsonlPath), false);
  // now that .err exists, it is no longer pending
  assert.equal(scanWorkspace(ws).length, 0);
  rmSync(ws, { recursive: true, force: true });
});

test('transcribeOne: unavailable backend leaves the file queued (no sidecar, no err, no append)', () => {
  const ws = makeWorkspace({ 'G@g.us': ['later.ogg'] });
  const item = scanWorkspace(ws)[0];
  const r = transcribeOne(item, () => ({ ok: false, unavailable: true, error: 'no whisper' }));
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.equal(existsSync(transcriptPathFor(item.file)), false);
  assert.equal(existsSync(errorPathFor(item.file)), false);
  assert.equal(existsSync(item.jsonlPath), false);
  assert.equal(scanWorkspace(ws).length, 1); // still pending for the next run
  rmSync(ws, { recursive: true, force: true });
});
