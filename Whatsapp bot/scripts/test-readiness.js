#!/usr/bin/env node
'use strict';

// Isolated offline regressions. The video/audio files below are generated and
// decoded by the actual packaged ffmpeg; WhatsApp and providers are simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-readiness-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
const use = (file) => require(path.join(ROOT, file));
const temp = use('utils/tempManager');
const cleanup = use('utils/cleanup');
const transfer = use('utils/mediaTransfer');
const ffmpeg = use('utils/ffmpeg');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('sweepers remove owned abandoned files but preserve holds, sessions and unrelated user files', () => {
  const root = temp.getTempDir();
  const dir = path.join(root, 'movies');
  const staging = path.join(dir, `.nm3u8_${Date.now()}_held`, 'tmp');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(path.join(root, 'session'), { recursive: true });
  fs.mkdirSync(path.join(root, 'database'), { recursive: true });
  const held = path.join(staging, 'segment.m4s');
  const owned = path.join(dir, 'movie_Example.0123456789abcdef.mp4');
  const ordinary = path.join(dir, 'family.mp4');
  const otherPartial = path.join(root, 'personal.tmp');
  const session = path.join(root, 'session', 'creds.json');
  const database = path.join(root, 'database', 'data.sqlite');
  for (const file of [held, owned, ordinary, otherPartial, session, database]) fs.writeFileSync(file, 'content');
  const release = temp.holdTemp(path.dirname(staging));
  try {
    cleanup.sweepBootPartials(root);
    cleanup.cleanupOldFiles(root, { now: Date.now() + 24 * 3600_000, maxMB: 0.00001 });
    assert.equal(fs.existsSync(owned), false);
    for (const file of [held, ordinary, otherPartial, session, database]) assert.equal(fs.existsSync(file), true, file);
  } finally { release(); }
  cleanup.sweepBootPartials(root);
  assert.equal(fs.existsSync(held), false);
  for (const file of [ordinary, otherPartial, session, database]) assert.equal(fs.existsSync(file), true, file);
});

test('cleanup rejects arbitrary and symlink-escaped paths while supporting configured movie temp', () => {
  const host = use('utils/movieHost');
  const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
  const root = fs.mkdtempSync(path.join(TMP, 'custom-movies-'));
  const own = path.join(root, 'movie_Example.0123456789abcdef.mp4');
  const unrelated = path.join(root, 'family.mp4');
  const victim = path.join(outside, 'movie_Victim.0123456789abcdef.mp4');
  fs.writeFileSync(own, 'own'); fs.writeFileSync(unrelated, 'user'); fs.writeFileSync(victim, 'user');
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
  fs.symlinkSync(outside, path.join(temp.getTempDir(), 'escape'), 'dir');
  const previous = process.env.TEMP_DIR;
  try {
    process.env.TEMP_DIR = root;
    assert.equal(host.cleanup(unrelated), false);
    assert.equal(host.cleanup(path.join(root, 'escape', path.basename(victim))), false);
    assert.equal(temp.deleteTempFile(path.join(temp.getTempDir(), 'escape', path.basename(victim))), false);
    assert.equal(host.cleanup(own), true);
    assert.equal(fs.existsSync(own), false);
    assert.equal(fs.existsSync(unrelated), true);
    assert.equal(fs.existsSync(victim), true);
  } finally { if (previous === undefined) delete process.env.TEMP_DIR; else process.env.TEMP_DIR = previous; }
});

test('movie jobs start together and get distinct paths even for the same title', async () => {
  const { JobQueue } = await import(pathToFileURL(path.join(ROOT, 'engine/core/queue.js')).href);
  const { targetFile } = await import(pathToFileURL(path.join(ROOT, 'engine/media/index.js')).href);
  const queue = new JobQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const jobs = Array.from({ length: 8 }, () => queue.add('one-chat', 'movie', async () => { started++; await gate; }));
  try {
    assert.equal(started, 8);
    assert.equal(queue.busy, 8);
    assert.equal(queue.size, 0);
    const names = Array.from({ length: 8 }, () => targetFile('Same title', '2020', 720));
    assert.equal(new Set(names).size, names.length);
  } finally { release(); await Promise.all(jobs); }
  assert.equal(queue.busy, 0);
  await assert.rejects(queue.add('one-chat', 'failed', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(queue.busy, 0);
});

test('movie cache sweeps respect active transfers and never unlink unrelated restored paths', async () => {
  const { default: cache, _internal } = await import(pathToFileURL(path.join(ROOT, 'engine/core/cache.js')).href);
  await cache.init({ installSignalHandlers: false });
  const dir = path.join(temp.getTempDir(), 'movies');
  fs.mkdirSync(dir, { recursive: true });
  const own = path.join(dir, 'movie_Clip.0123456789abcdef.mp4');
  const user = path.join(dir, 'personal.mp4');
  const bookkeeping = path.join(dir, 'cache.json');
  fs.writeFileSync(own, 'owned'); fs.writeFileSync(user, 'personal'); fs.writeFileSync(bookkeeping, '{}');
  cache.fset('own', { file: own, sizeMB: 1 });
  cache.fset('user', { file: user, sizeMB: 1 });
  _internal.files.get('own').at = 0;
  _internal.files.get('user').at = 0;
  const release = temp.holdTemp(own);
  try { await cache.sweep(); assert.equal(fs.existsSync(own), true); }
  finally { release(); }
  await cache.sweep();
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.existsSync(user), true);
  assert.equal(fs.existsSync(bookkeeping), true);
});

test('already-compatible faststart MP4 avoids a copy; trailing moov is remuxed and both decode', { skip: !ffmpeg.works() }, async () => {
  const root = temp.getTempDir();
  const fast = path.join(root, 'fast-fixture.mp4');
  const slow = path.join(root, 'slow-fixture.mp4');
  const outFast = path.join(root, 'out-fast.mp4');
  const outSlow = path.join(root, 'out-slow.mp4');
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  execFileSync(ffmpeg(), [...args, '-movflags', '+faststart', fast], { stdio: 'pipe' });
  execFileSync(ffmpeg(), [...args, slow], { stdio: 'pipe' });
  assert.equal(transfer.hasFastStartMp4(fast), true);
  assert.equal(transfer.hasFastStartMp4(slow), false);
  const info = await transfer.probeMedia(fast);
  assert.ok(info.probed && info.hasAudio && info.hasVideo && info.duration > 0);
  assert.equal(await transfer.ensureWhatsAppMp4(fast, outFast, { info }), fast);
  assert.equal(fs.existsSync(outFast), false);
  assert.equal(await transfer.ensureWhatsAppMp4(slow, outSlow), outSlow);
  assert.equal(transfer.hasFastStartMp4(outSlow), true);
  for (const file of [fast, outSlow]) execFileSync(ffmpeg(), ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { stdio: 'pipe' });
});

test('buffer conversion returns real audio and removes temp files on success and error', { skip: !ffmpeg.works() }, async () => {
  const converter = use('utils/converter');
  const wav = path.join(TMP, 'audio.wav');
  execFileSync(ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', wav], { stdio: 'pipe' });
  const result = await converter.toAudio(fs.readFileSync(wav), 'wav');
  assert.ok(Buffer.isBuffer(result) && result.length > 1000);
  const out = path.join(TMP, 'converted.mp3'); fs.writeFileSync(out, result);
  execFileSync(ffmpeg(), ['-v', 'error', '-xerror', '-i', out, '-f', 'null', '-'], { stdio: 'pipe' });
  await assert.rejects(converter.toAudio(Buffer.from('not audio'), 'wav'));
  assert.deepEqual(fs.readdirSync(temp.getTempDir()).filter((name) => name.startsWith('conv_')), []);
});
