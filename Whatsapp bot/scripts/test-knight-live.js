#!/usr/bin/env node
'use strict';

// Opt-in integration smoke test: real provider, real complete download, actual
// bot command and full FFmpeg decode. Only the WhatsApp socket is a fixture.
// No .env, account, cookie, session or database from the host is read.
const mode = String(process.argv[2] || '');
if (process.env.KNIGHT_LIVE !== '1' || !['song', 'video', 'dl-audio', 'title'].includes(mode)) {
  console.error('Opt in with KNIGHT_LIVE=1 and choose song, video, dl-audio or title.');
  process.exit(2);
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'knight-live-'));
const root = createBotFixture(temporary);
process.chdir(temporary);
const fromBot = (relative) => require(path.join(root, relative));
const config = fromBot('config');
const probe = fromBot('utils/mediaTransfer').probeMedia;
const ffmpeg = fromBot('utils/ffmpeg');
const command = fromBot(mode === 'video' ? 'commands/media/ytv' : mode === 'dl-audio' ? 'commands/media/dl' : 'commands/media/song');
const msg = { key: { remoteJid: 'fixture@s.whatsapp.net', id: 'live-test' }, message: {} };
const extra = { from: 'fixture@s.whatsapp.net', isOwner: true };
const sample = 'https://www.youtube.com/watch?v=H5eLnIhRpWg';
let sent = false;
let capturedError = '';
const sock = { async sendMessage(_chat, body) {
  if (body.text) capturedError = String(body.text).slice(0, 500);
  const media = body.document || body.audio || body.video;
  if (!media) return { key: { id: 'fixture' } };
  assert.match(body.caption || '', /via Hector/i, 'actual preferred provider must be used');
  assert.ok(fs.existsSync(media.url), 'file must exist during delivery');
  const info = await probe(media.url);
  assert.ok(info.probed && info.hasAudio, 'output must have an audio stream');
  if (mode === 'video') assert.ok(info.hasVideo, 'output must also have a video stream');
  const maps = mode === 'video' ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:a:0'];
  execFileSync(ffmpeg(), ['-v', 'error', '-xerror', '-i', media.url, ...maps, '-f', 'null', '-'], {
    timeout: 180000, stdio: 'ignore',
  });
  sent = true;
  return { key: { id: 'fixture' } };
} };

(async () => {
  assert.ok(ffmpeg.works(), 'FFmpeg is required');
  // Keep the result selection deterministic; do not write to the real settings.
  config.search.picker = false;
  if (mode === 'video') await command.execute(sock, msg, [sample, '360'], extra);
  else if (mode === 'dl-audio') await command.execute(sock, msg, [sample, 'audio'], extra);
  else if (mode === 'title') await command.execute(sock, msg, ['Colin', 'Mutchler', 'The', 'New', 'Music', 'Alex', 'Beroza', '--first'], extra);
  else await command.execute(sock, msg, [sample], extra);
  assert.ok(sent, `real ${mode} command did not deliver a decoded media file${capturedError ? ': ' + capturedError : ''}`);
  console.log(`::notice title=Live bot media::${mode}: real command, full download and full decode passed via Hector`);
})().catch((err) => {
  console.log(`::error title=Live bot media::${mode}: ${String(err.message || 'failed').replace(/[\r\n]/g, ' ').slice(0, 500)}`);
  process.exitCode = 1;
}).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
