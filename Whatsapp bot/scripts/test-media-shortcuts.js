#!/usr/bin/env node
'use strict';

// Exercises real shortcut handlers and option parsing, but replaces the shared
// downloader with a recorder. No site or WhatsApp request is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-shortcuts-'));
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
  test(`${name} forwards a public video URL and quality through the shared pipeline`, async () => {
    const cmd = find(name);
    assert.ok(cmd, `${name} not registered`);
    last = null;
    await cmd.execute(sock, msg, [url, '480'], extra);
    assert.equal(last.url, url);
    assert.equal(last.kind, 'video');
    assert.equal(last.height, 480);
    assert.equal(last.lane, 'heavy');
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

test('Bilibili short and international hosts and quoted messages are forwarded', async () => {
  const cmd = find('bili');
  const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: 'https://b23.tv/abcdefg' } } } } };
  await cmd.execute(sock, quoted, [], extra);
  assert.equal(last.url, 'https://b23.tv/abcdefg');
  assert.equal(last.attempts[0].code, 'OK');
  await cmd.execute(sock, msg, ['https://www.bilibili.tv/en/video/1234567890123'], extra);
  assert.equal(last.attempts[0].code, 'OK');
});

test('audio mode uses the light lane; custom prefix is used in usage', async () => {
  await find('bilibili').execute(sock, msg, [cases[0][1], 'audio'], extra);
  assert.equal(last.kind, 'audio');
  assert.equal(last.lane, 'light');
  sock.sent.length = 0;
  await find('bilibili').execute(sock, msg, [], extra);
  assert.match(sock.sent[0].text, /!bilibili/);
});

test('a lookalike host is not reported as the named site, but legacy permissive shortcut behavior is retained', async () => {
  const url = 'https://example.org/?next=https://www.bilibili.com/video/BV1xx411c7mD';
  await find('bilibili').execute(sock, msg, [url], extra);
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
