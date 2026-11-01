'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const mode = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-timing-'));
const bot = createBotFixture(tmp);
process.chdir(tmp);
const get = (p) => require(path.join(bot, p));
const times = {};
const wrap = (obj, name) => {
  const orig = obj[name];
  obj[name] = async (...args) => { const t = Date.now(); try { return await orig(...args); } finally { (times[name] ||= []).push(Date.now() - t); } };
};
const media = get('utils/mediaTransfer');
for (const n of ['probeMedia', 'ensureWhatsAppMp4', 'tagMp3']) wrap(media, n);
const providers = get('utils/downloadProviders');
for (const n of ['resolveMedia', 'fetchCandidate']) wrap(providers, n);
const search = get('utils/youtubeSearch'); wrap(search, 'searchYouTube');
const config = get('config'); config.search.picker = false;
const command = mode === 'fb' ? get('commands/media/shortcuts').find(c => c.name === 'fb') : get(mode === 'video' ? 'commands/media/ytv' : 'commands/media/song');
const msg = { key: { remoteJid: 'fixture@s.whatsapp.net', id: 'test' }, message: {} };
const extra = { from: msg.key.remoteJid, isOwner: true };
let delivered = false, deliveryMs = 0, decodeMs = 0, caption = null, output, captured = '';
let start;
const sock = { async sendMessage(_chat, body) {
  if (body.text) captured = String(body.text).slice(0, 200);
  const file = body.document?.url || body.audio?.url || body.video?.url;
  if (!file) return { key: { id: 'fixture' } };
  output = file; caption = Object.prototype.hasOwnProperty.call(body, 'caption');
  deliveryMs = Date.now() - start;
  assert.ok(fs.existsSync(file));
  const maps = mode === 'song' || mode === 'title' ? ['-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a:0'];
  const t = Date.now();
  execFileSync(get('utils/ffmpeg')(), ['-v', 'error', '-xerror', '-i', file, ...maps, '-f', 'null', '-'], { timeout: 180000, stdio: 'ignore' });
  decodeMs = Date.now() - t;
  delivered = true;
  return { key: { id: 'fixture' } };
} };
(async () => {
  start = Date.now();
  const sample = 'https://www.youtube.com/watch?v=H5eLnIhRpWg';
  const args = mode === 'video' ? [sample, '360'] : mode === 'title' ? ['Colin', 'Mutchler', 'The', 'New', 'Music', 'Alex', 'Beroza', '--first'] : mode === 'fb' ? ['https://www.facebook.com/3DModels.48/videos/big-buck-bunny/189491341567830/'] : [sample];
  await command.execute(sock, msg, args, extra);
  if (!delivered) { console.log(`TIMING ${mode}: no-delivery ${captured.replace(/[\r\n]/g, ' ').slice(0, 200)}`); if(mode !== 'fb') process.exitCode = 1; }
  else {
    console.log(`TIMING ${mode}: delivery=${deliveryMs}ms decode=${decodeMs}ms caption=${caption} cleanup=${!fs.existsSync(output)} stages=${JSON.stringify(times)}`);
  }
})().catch(e => { console.log(`TIMING ${mode}: failed ${e.code || e.name}`); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
