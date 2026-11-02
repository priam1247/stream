#!/usr/bin/env node
'use strict';

// Exercises real shortcut handlers and option parsing, but replaces the shared
// downloader with a recorder. No site or WhatsApp request is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-shortcuts-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
process.env.PREFIX = '!';
process.env.YT_AUTH_FILE = path.join(TMP, 'oauth.json');
const pipeline = require(path.join(ROOT, 'utils/mediaPipeline'));
const socialMedia = require(path.join(ROOT, 'utils/socialMedia'));
let last;
let lastSocial;
pipeline.downloadAndSend = async (sock, msg, extra, options) => { last = { sock, msg, extra, ...options }; return { sent: true }; };
socialMedia.downloadAndSend = async (sock, msg, extra, options) => { lastSocial = { sock, msg, extra, ...options }; return { sent: true }; };
const commands = require(path.join(ROOT, 'commands/media/shortcuts'));
const menu = require(path.join(ROOT, 'commands/general/menu'));
const cases = [
  ['reddit', 'https://www.reddit.com/r/test/comments/abc123/example/'],
];
const find = (name) => commands.find((c) => c.name === name || c.aliases.includes(name));
const msg = { key: { remoteJid: 'self@s.whatsapp.net' }, message: {} };
const extra = { from: 'self@s.whatsapp.net', isOwner: false };
const sock = { sent: [], async sendMessage(_id, body) { this.sent.push(body); } };
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

for (const [name, url] of cases) {
  test(`${name} rejects a pasted link without searching or downloading it`, async () => {
    const cmd = find(name);
    assert.ok(cmd, `${name} not registered`);
    last = null;
    sock.sent.length = 0;
    await cmd.execute(sock, msg, [url, '480'], extra);
    assert.equal(last, null);
    assert.match(sock.sent.at(-1).text, /searches titles only.*[!.]song or [!.]video/i);
    const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: url } } } } };
    sock.sent.length = 0;
    await cmd.execute(sock, quoted, ['--audio'], extra);
    assert.equal(last, null);
    assert.match(sock.sent.at(-1).text, /searches titles only.*[!.]song or [!.]video/i);
  });
}

const linkCases = [
  ['tiktok', 'https://www.tiktok.com/@creator/video/123456789'],
  ['x', 'https://x.com/creator/status/123456789'],
];
for (const [name, url] of linkCases) {
  test(`${name} keeps the existing link and legacy quality behavior`, async () => {
    last = null;
    await find(name).execute(sock, msg, [url, '480'], extra);
    assert.equal(last.url, url);
    assert.equal(last.kind, 'video');
    assert.equal(last.height, 480);
    assert.equal(last.attempts[0].code, 'OK');
  });
}

test('Facebook and Instagram use their dedicated XJX-style resolvers', async () => {
  const fbUrl = 'https://www.facebook.com/watch/?v=123456789';
  const igUrl = 'https://www.instagram.com/reel/Example/';
  last = null;
  lastSocial = null;
  await find('fb').execute(sock, msg, [fbUrl], extra);
  assert.equal(last, null);
  assert.equal(lastSocial.platform, 'facebook');
  assert.equal(lastSocial.url, fbUrl);
  assert.equal(lastSocial.quality, 1080);
  await find('fb').execute(sock, msg, [fbUrl, '480'], extra);
  assert.equal(lastSocial.quality, 480);
  await find('ig').execute(sock, msg, [igUrl], extra);
  assert.equal(last, null);
  assert.equal(lastSocial.platform, 'instagram');
  assert.equal(lastSocial.url, igUrl);
});

test('remaining aliases are unique and point to their canonical commands', () => {
  assert.equal(find('tt').name, 'tiktok');
  assert.equal(find('twitter').name, 'x');
  assert.equal(find('ig').name, 'instagram');
  assert.equal(find('facebook').name, 'fb');
  const allNames = commands.flatMap((c) => [c.name, ...c.aliases]);
  assert.equal(new Set(allNames).size, allNames.length);
});

test('new shortcuts do not download quoted or scheme-less links', async () => {
  const cmd = find('reddit');
  const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: 'https://www.reddit.com/r/test/comments/abc123/example/' } } } } };
  for (const [message, args] of [[quoted, []], [quoted, ['--audio']], [msg, ['www.reddit.com/r/test/comments/abc123/example/']]]) {
    last = null;
    sock.sent.length = 0;
    await cmd.execute(sock, message, args, extra);
    assert.equal(last, null);
    assert.match(sock.sent.at(-1).text, /searches titles only.*[!.]song or [!.]video/i);
  }
});

test('older shortcuts apply explicit flags before or after links, including quoted links', async () => {
  const url = linkCases[0][1];
  const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: url } } } } };
  for (const [message, args] of [
    [msg, ['--audio', '--quality', '360', url]],
    [msg, [url, '--audio', '--quality=360']],
    [quoted, ['--audio', '--quality', '360']],
  ]) {
    last = null;
    await find('tiktok').execute(sock, message, args, extra);
    assert.equal(last.url, url);
    assert.equal(last.kind, 'audio');
    assert.equal(last.height, 360);
    assert.equal(last.lane, 'light');
  }
  sock.sent.length = 0;
  await find('reddit').execute(sock, msg, [], extra);
  assert.match(sock.sent[0].text, /!reddit/);
});

test('invalid explicit link quality never starts an older shortcut download', async () => {
  const url = linkCases[0][1];
  const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: url } } } } };
  for (const [message, args] of [[msg, ['--quality=999', url]], [msg, [url, '--quality', '999']], [quoted, ['--quality=999']]]) {
    last = null;
    sock.sent.length = 0;
    await find('tiktok').execute(sock, message, args, extra);
    assert.equal(last, null);
    assert.match(sock.sent.at(-1).text, /Quality must be/);
  }
});

test('an older shortcut still forwards a lookalike host but reports the mismatch', async () => {
  const url = 'https://example.org/?next=https://www.tiktok.com/video/123';
  await find('tiktok').execute(sock, msg, [url], extra);
  assert.equal(last.url, url);
  assert.equal(last.attempts[0].code, 'HOST_MISMATCH');
});

test('media menu exposes Reddit without exposing admin commands', () => {
  const groups = menu._buildGroups('!', { isOwner: false });
  const text = menu._buildCard(groups, null, { prefix: '!' });
  assert.ok(text.includes('!reddit'));
  assert.doesNotMatch(text, /!cookies|!ytdl/);
});
