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
let last;
pipeline.downloadAndSend = async (sock, msg, extra, options) => { last = { sock, msg, extra, ...options }; return { sent: true }; };
const commands = require(path.join(ROOT, 'commands/media/shortcuts'));
const menu = require(path.join(ROOT, 'commands/general/menu'));
const cases = [
  ['bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD'],
  ['vimeo', 'https://vimeo.com/76979871'],
  ['dailymotion', 'https://www.dailymotion.com/video/x7xyz'],
  ['reddit', 'https://www.reddit.com/r/test/comments/abc123/example/'],
  ['twitch', 'https://www.twitch.tv/videos/123456789'],
  ['rumble', 'https://rumble.com/v1xyz-example.html'],
  ['odysee', 'https://odysee.com/@example:1/title:2'],
  ['weibo', 'https://www.weibo.com/1234567890/ABCxyz123'],
  ['douyin', 'https://www.douyin.com/video/1234567890123456789'],
  ['acfun', 'https://www.acfun.cn/v/ac12345678'],
  ['youku', 'https://v.youku.com/v_show/id_XNTk2Mzc2OT.html'],
  ['vk', 'https://vk.com/video-123456_789012'],
  ['xiaohongshu', 'https://www.xiaohongshu.com/explore/123456789012345678901234'],
  ['niconico', 'https://www.nicovideo.jp/watch/sm9'],
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
    assert.match(sock.sent.at(-1).text, /searches titles only.*!dl/i);
    const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: url } } } } };
    sock.sent.length = 0;
    await cmd.execute(sock, quoted, ['--audio'], extra);
    assert.equal(last, null);
    assert.match(sock.sent.at(-1).text, /searches titles only.*!dl/i);
  });
}

const linkCases = [
  ['tiktok', 'https://www.tiktok.com/@creator/video/123456789'],
  ['x', 'https://x.com/creator/status/123456789'],
  ['pinterest', 'https://www.pinterest.com/pin/123456789/'],
  ['instagram', 'https://www.instagram.com/reel/Example/'],
  ['fb', 'https://www.facebook.com/watch/?v=123456789'],
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

test('aliases are unique and point to their canonical commands', () => {
  assert.equal(find('bili').name, 'bilibili');
  assert.equal(find('daily').name, 'dailymotion');
  assert.equal(find('xhs').name, 'xiaohongshu');
  assert.equal(find('nico').name, 'niconico');
  const allNames = commands.flatMap((c) => [c.name, ...c.aliases]);
  assert.equal(new Set(allNames).size, allNames.length);
});

test('new shortcuts do not download quoted or scheme-less links', async () => {
  const cmd = find('bili');
  const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: 'https://b23.tv/abcdefg' } } } } };
  for (const [message, args] of [[quoted, []], [quoted, ['--audio']], [msg, ['www.bilibili.com/video/BV1xx411c7mD']]]) {
    last = null;
    sock.sent.length = 0;
    await cmd.execute(sock, message, args, extra);
    assert.equal(last, null);
    assert.match(sock.sent.at(-1).text, /searches titles only.*!dl/i);
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
  await find('bilibili').execute(sock, msg, [], extra);
  assert.match(sock.sent[0].text, /!bilibili/);
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

test('media menu exposes the new shortcuts without exposing admin commands', () => {
  const groups = menu._buildGroups('!', { isOwner: false });
  const text = menu._buildCard(groups, null, { prefix: '!' });
  for (const name of ['bilibili', 'vimeo', 'dailymotion', 'reddit', 'twitch', 'rumble', 'odysee', 'weibo', 'douyin', 'acfun', 'youku', 'vk', 'xhs', 'niconico']) {
    assert.ok(text.includes(`!${name}`), name);
  }
  assert.doesNotMatch(text, /!cookies|!ytdl/);
});
