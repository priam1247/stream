#!/usr/bin/env node
'use strict';

// Opt-in integration smoke test: call the XJX media resolver and verify that
// the actual bot command hands Baileys a public HTTPS media URL. No WhatsApp
// connection, account, cookie, session or database from the host is used.
const mode = String(process.argv[2] || '');
if (process.env.KNIGHT_LIVE !== '1' || !['song', 'video', 'title'].includes(mode)) {
  console.error('Opt in with KNIGHT_LIVE=1 and choose song, video or title.');
  process.exit(2);
}
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xjx-live-'));
const root = createBotFixture(temporary);
process.chdir(temporary);
const fromBot = (relative) => require(path.join(root, relative));
const command = fromBot(mode === 'video' ? 'commands/media/video' : 'commands/media/song');
const msg = { key: { remoteJid: 'fixture@s.whatsapp.net', id: 'live-test' }, message: {} };
const extra = { from: 'fixture@s.whatsapp.net', isOwner: true };
const sample = 'https://www.youtube.com/watch?v=H5eLnIhRpWg';
let sentUrl = '';
let capturedError = '';
const sock = { async sendMessage(_chat, body) {
  if (body.text) capturedError = String(body.text).slice(0, 500);
  const media = body.document || body.audio || body.video;
  if (!media) return { key: { id: 'fixture' } };
  sentUrl = String(media.url || '');
  assert.match(sentUrl, /^https:\/\//, 'command did not deliver a remote HTTPS URL');
  return { key: { id: 'fixture' } };
} };

(async () => {
  if (mode === 'title') await command.execute(sock, msg, ['Colin', 'Mutchler', 'The', 'New', 'Music', 'Alex', 'Beroza'], extra);
  else await command.execute(sock, msg, [sample], extra);
  assert.ok(sentUrl, `real ${mode} command did not deliver a media URL${capturedError ? ': ' + capturedError : ''}`);
  console.log(`::notice title=XJX live resolver::${mode}: real command resolved a remote media URL`);
})().catch((err) => {
  console.log(`::error title=XJX live resolver::${mode}: ${String(err.message || 'failed').replace(/[\r\n]/g, ' ').slice(0, 500)}`);
  process.exitCode = 1;
}).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
