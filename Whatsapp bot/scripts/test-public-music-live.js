#!/usr/bin/env node
'use strict';

// Explicit, opt-in host smoke test. Uses public sample files only; it never
// touches a real .env, WhatsApp session, database, cookies or credentials.
// Example: PUBLIC_MUSIC_LIVE=1 node scripts/test-public-music-live.js audius
const enabled = process.env.PUBLIC_MUSIC_LIVE === '1';
const mode = String(process.argv[2] || '');
if (!enabled || !['audius', 'commons-audio', 'commons-video'].includes(mode)) {
  console.error('Opt in with PUBLIC_MUSIC_LIVE=1 and choose audius, commons-audio or commons-video.');
  process.exit(2);
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'public-music-live-'));
const root = createBotFixture(temporary);
process.chdir(temporary);
const at = (relative) => require(path.join(root, relative));
const audius = at('utils/audius');
const commons = at('utils/commonsMedia');
const ffmpeg = at('utils/ffmpeg');
const { probeMedia } = at('utils/mediaTransfer');
const { sendPublicMedia } = at('utils/publicMediaDelivery');
const message = { key: { remoteJid: 'fixture@s.whatsapp.net', id: 'live-test' }, message: {} };
const extra = { from: 'fixture@s.whatsapp.net', isOwner: true };
let received = false;
const sock = { async sendMessage(_chat, body) {
  const media = body.document || body.audio || body.video;
  if (!media) return;
  assert.ok(fs.existsSync(media.url), 'file exists during delivery');
  const info = await probeMedia(media.url);
  assert.ok(info.probed && info.hasAudio, 'output has audio');
  if (mode === 'commons-video') {
    assert.ok(info.hasVideo && info.videoCodec === 'h264' && info.audioCodec === 'aac', 'video is H.264/AAC');
    assert.match(body.caption, /CC BY-SA 3\.0/);
    assert.match(body.caption, /commons\.wikimedia\.org\/wiki\/File/);
  }
  if (mode === 'commons-audio') {
    assert.match(body.caption, /CC BY-SA 4\.0/);
    assert.match(body.caption, /commons\.wikimedia\.org\/wiki\/File/);
  }
  // Decode the whole downloaded output; metadata and headers alone are not a playback test.
  const maps = mode === 'commons-video' ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:a:0'];
  execFileSync(ffmpeg(), ['-v', 'error', '-i', media.url, ...maps, '-f', 'null', '-'], { timeout: 180000, stdio: 'pipe' });
  received = true;
} };

async function run() {
  assert.ok(ffmpeg.works(), 'FFmpeg is required');
  let result;
  if (mode === 'audius') {
    const client = audius.createClient();
    const found = await client.search('Tеееest', { limit: 3 });
    const item = found.find((row) => row.id === 'xd8gY');
    assert.ok(item, 'creator-enabled Audius sample must appear in filtered search');
    result = await sendPublicMedia(sock, message, extra, {
      kind: 'audio', label: 'Audius', download: (dest, limits) => client.downloadTrack(item.id, dest, limits),
    });
  } else {
    const client = commons.createClient();
    const kind = mode === 'commons-video' ? 'video' : 'audio';
    const id = kind === 'video' ? 4284283 : 78943371;
    const query = kind === 'video' ? 'Bach' : 'Moonlight Sonata';
    const found = await client.search(query, { kind, limit: 10 });
    const item = found.find((row) => row.id === id);
    assert.ok(item, 'Commons sample must appear in filtered search');
    result = await sendPublicMedia(sock, message, extra, {
      kind, label: 'Wikimedia Commons', attribution: commons.attributionFor,
      download: (dest, limits) => client.downloadItem(id, dest, { ...limits, kind }),
    });
  }
  assert.equal(result.sent, true, `delivery failed (${result.code || 'unknown'})`);
  assert.ok(received, 'media was not delivered to the test socket');
  console.log(`${mode}: search, permission/license checks, download, conversion and full decode passed`);
}

run().catch((err) => { console.error(`Public media smoke test failed: ${err.message}`); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
