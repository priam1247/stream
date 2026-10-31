#!/usr/bin/env node
'use strict';

// Exercises actual WhatsApp command dispatch and scoped selections with network
// search and media download stubbed; no WhatsApp or provider connection is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-search-handler-'));
const BOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(BOT, 'scripts', 'test-provider-search-handler.js'));
process.chdir(TMP);
botRequire('../utils/telemetry')._resetForTests(null);
process.env.OWNER_NUMBER = '15550000001';
process.env.ADMIN_NUMBERS = '15550000002';
process.env.PREFIX = '.';
process.env.SEARCH_RESULTS = '2';
process.env.SEARCH_TTL_MINUTES = '2';
process.env.QUEUE_MIN_FREE_MB = '0';

const database = botRequire('../database');
database.getBotState = () => true;
const pipeline = botRequire('../utils/mediaPipeline');
const config = botRequire('../config');
const providerSearch = botRequire('../utils/providerSearch');
const selections = botRequire('../utils/selections');
const jobQueue = botRequire('../utils/jobQueue');
const policy = botRequire('../utils/memberCommandPolicy');
const originalPolicy = policy.isUnavailable;
const downloads = [];
const searches = [];
let disabled = new Set();
let outcome = 'ok';

const urls = {
  bilibili: 'https://www.bilibili.com/video/BV1xx411c7mD',
  vimeo: 'https://vimeo.com/76979871',
  dailymotion: 'https://www.dailymotion.com/video/x7xyz',
  reddit: 'https://www.reddit.com/r/test/comments/abc123/example/',
  twitch: 'https://www.twitch.tv/videos/123456789',
  rumble: 'https://rumble.com/v1xyz-example.html',
  odysee: 'https://odysee.com/@example:1/title:2',
  weibo: 'https://www.weibo.com/1234567890/ABCxyz123',
  douyin: 'https://www.douyin.com/video/1234567890123456789',
  acfun: 'https://www.acfun.cn/v/ac12345678',
  youku: 'https://v.youku.com/v_show/id_XNTk2Mzc2OT.html',
  vk: 'https://vk.com/video-123456_789012',
  xiaohongshu: 'https://www.xiaohongshu.com/explore/123456789012345678901234',
  niconico: 'https://www.nicovideo.jp/watch/sm9',
};

pipeline.downloadAndSend = async (_sock, _msg, extra, options) => { downloads.push({ ...options, extra }); };
providerSearch.searchProvider = async (site, query, opts) => {
  searches.push({ site, query, opts });
  if (outcome !== 'ok') return { status: outcome, source: '', results: [] };
  return { status: 'ok', source: 'fixture', results: [
    { url: urls[site], title: `${site} first`, author: 'Creator', duration: 63, episode: site === 'youku' ? 1 : 0 },
    { url: urls[site], title: `${site} second`, author: '', duration: 0 },
  ] };
};
policy.isUnavailable = (name) => disabled.has(name);
const handler = botRequire('../handler');

function socket(id = 'linked:one', number = '15550001111') {
  return {
    __sessionId: id, __accountNumber: number,
    user: { id: `${number}:1@s.whatsapp.net` },
    sent: [],
    async sendMessage(_chat, content) {
      this.sent.push(content);
      return { key: { id: `prompt-${this.sent.length}` } };
    },
  };
}
let next = 0;
function msg(text, { fromMe = true, chat = 'group@g.us', quoted = null } = {}) {
  const body = quoted
    ? { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: quoted } } } }
    : { conversation: text };
  return { key: { id: `m-${++next}`, fromMe, remoteJid: chat }, message: body };
}

test.beforeEach(() => { downloads.length = 0; searches.length = 0; disabled = new Set(); outcome = 'ok'; });
test.after(() => { policy.isUnavailable = originalPolicy; fs.rmSync(TMP, { recursive: true, force: true }); });

for (const [site, url] of Object.entries(urls)) {
  test(`${site} searches titles, creates a scoped prefixed picker and downloads the chosen provider URL`, async () => {
    const sock = socket(`test:${site}`);
    await handler.handleMessage(sock, msg(`.${site} a video title`));
    assert.deepEqual(searches.map((s) => [s.site, s.query, s.opts.limit]), [[site, 'a video title', 2]]);
    assert.equal(downloads.length, 0);
    assert.match(sock.sent.map((s) => s.text || '').join('\n'), /results[\s\S]*\.1[\s\S]*\.cancel/i);
    const entry = selections.peek('group@g.us', ['15550001111@s.whatsapp.net'], { scope: sock.__sessionId });
    assert.ok(entry);
    assert.equal(entry.commandName, site);
    assert.equal(entry.ttlMs, 120000);
    await handler.handleMessage(sock, msg('1')); // prefix is required
    await handler.handleMessage(sock, msg('.1', { fromMe: false })); // only the linked account itself
    assert.equal(downloads.length, 0);
    await handler.handleMessage(sock, msg('.1'));
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].url, url);
    assert.equal(downloads[0].kind, 'video');
    assert.equal(downloads[0].attempts[0].code, 'OK');
  });
}

test('the example keeps episode text intact; title words are not mistaken for download options', async () => {
  const sock = socket('example');
  await handler.handleMessage(sock, msg('.youku the blood of youth s01e1 --audio 480p'));
  assert.equal(searches[0].query, 'the blood of youth s01e1');
  assert.match(sock.sent.map((s) => s.text || '').join('\n'), /Episode 1/);
  await handler.handleMessage(sock, msg('.2'));
  assert.equal(downloads[0].kind, 'audio');
  assert.equal(downloads[0].height, 480);
  assert.equal(downloads[0].lane, 'light');
  await handler.handleMessage(sock, msg('.youku the music video --first'));
  assert.equal(searches[1].query, 'the music video');
  assert.equal(downloads.length, 2);
  assert.equal(downloads[1].kind, 'video');
});

test('aliases, explicit quality and --first preserve the requested provider and options', async () => {
  const sock = socket('aliases');
  await handler.handleMessage(sock, msg('.bili example --quality 360 --audio --first'));
  assert.equal(searches[0].site, 'bilibili');
  assert.equal(searches[0].query, 'example');
  assert.equal(downloads[0].url, urls.bilibili);
  assert.equal(downloads[0].kind, 'audio');
  assert.equal(downloads[0].height, 360);
  await handler.handleMessage(sock, msg('.daily another title --first'));
  await handler.handleMessage(sock, msg('.xhs another title --first'));
  await handler.handleMessage(sock, msg('.nico another title --first'));
  assert.deepEqual(searches.map((s) => s.site), ['bilibili', 'dailymotion', 'xiaohongshu', 'niconico']);
});

test('new shortcuts reject pasted and quoted links, while typed one-word titles always search', async () => {
  const sock = socket('title-only');
  await handler.handleMessage(sock, msg(`.youku ${urls.youku} --audio --quality 480`));
  await handler.handleMessage(sock, msg('.youku --audio --quality=360', { quoted: urls.youku }));
  assert.equal(searches.length, 0);
  assert.equal(downloads.length, 0);
  assert.match(sock.sent.at(-1).text, /searches titles only.*\.dl/i);

  await handler.handleMessage(sock, msg('.vimeo video', { quoted: urls.vimeo }));
  await handler.handleMessage(sock, msg('.vimeo music', { quoted: urls.vimeo }));
  assert.deepEqual(searches.map(({ site, query }) => [site, query]), [['vimeo', 'video'], ['vimeo', 'music']]);
  assert.equal(downloads.length, 0);
  await handler.handleMessage(sock, msg('.1'));
  assert.equal(downloads[0].url, urls.vimeo);
});

test('cancel, expiry, unrelated quotes and other sessions cannot pick an outstanding search', async () => {
  const first = socket('scope:first');
  const second = socket('scope:second');
  await handler.handleMessage(first, msg('.youku a title'));
  await handler.handleMessage(second, msg('.1'));
  assert.equal(downloads.length, 0);
  const entry = selections.peek('group@g.us', ['15550001111@s.whatsapp.net'], { scope: first.__sessionId });
  assert.equal(selections.match('group@g.us', ['15550001111@s.whatsapp.net'], '1', { scope: first.__sessionId, quotedMessageId: 'other-message' }), null);
  await handler.handleMessage(first, msg('.cancel'));
  assert.equal(selections.peek('group@g.us', ['15550001111@s.whatsapp.net'], { scope: first.__sessionId }), null);
  await handler.handleMessage(first, msg('.youku another title'));
  const expiring = selections.peek('group@g.us', ['15550001111@s.whatsapp.net'], { scope: first.__sessionId });
  expiring.at -= expiring.ttlMs + 1;
  await handler.handleMessage(first, msg('.1'));
  assert.equal(downloads.length, 0);
  assert.equal(entry.consumed, true);
});

test('member policy is rechecked for an outstanding aliased search; owner remains able to test', async () => {
  const member = socket('member');
  const owner = socket('owner', '15550000001');
  await handler.handleMessage(member, msg('.bili title'));
  const entry = selections.peek('group@g.us', ['15550001111@s.whatsapp.net'], { scope: member.__sessionId });
  assert.equal(entry.commandName, 'bili');
  disabled.add('bilibili');
  await handler.handleMessage(member, msg('.1'));
  assert.equal(downloads.length, 0);
  assert.match(member.sent.map((m) => m.text || '').join(' '), /temporarily unavailable/i);
  await handler.handleMessage(owner, msg('.bili title --first'));
  assert.equal(downloads[0].url, urls.bilibili);
});

test('a full search lane queues searches without occupying a light download slot', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = Array.from({ length: 4 }, () => jobQueue.runInLane('search', () => gate));
  let nextStarted = false;
  const queued = jobQueue.runInLane('search', async () => { nextStarted = true; });
  try {
    assert.equal(jobQueue.stats().search.running, 4);
    assert.equal(jobQueue.stats().search.waiting, 1);
    const light = await jobQueue.runInLane('light', async () => 'download-started');
    assert.equal(light, 'download-started');
    assert.equal(nextStarted, false);
  } finally {
    release();
    await Promise.allSettled([...running, queued]);
  }
  assert.equal(nextStarted, true);
  assert.equal(jobQueue.stats().search.running, 0);
});

test('a search waiting for memory retries until memory recovers', async () => {
  const oldFree = os.freemem;
  const oldMinimum = config.queue.minFreeMB;
  config.queue.minFreeMB = 1;
  os.freemem = () => 0;
  let started = false;
  const pending = jobQueue.runInLane('search', async () => { started = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(started, false);
    os.freemem = () => 2 * 1024 * 1024;
    let timer;
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('search did not retry')), 3000); }),
      ]);
    } finally { clearTimeout(timer); }
    assert.equal(started, true);
  } finally {
    os.freemem = oldFree;
    config.queue.minFreeMB = oldMinimum;
    await pending;
  }
});

test('no results, service failures, invalid quality and long titles give useful errors without downloads', async () => {
  const sock = socket('errors');
  outcome = 'empty';
  await handler.handleMessage(sock, msg('.youku a title'));
  assert.match(sock.sent.at(-1).text, /No Youku videos found/);
  outcome = 'unavailable';
  await handler.handleMessage(sock, msg('.youku another title'));
  assert.match(sock.sent.at(-1).text, /search is unavailable/i);
  const count = searches.length;
  await handler.handleMessage(sock, msg('.youku a title --quality=999'));
  assert.match(sock.sent.at(-1).text, /Quality must be/);
  await handler.handleMessage(sock, msg(`.youku ${'a'.repeat(201)}`));
  assert.match(sock.sent.at(-1).text, /200 characters/);
  assert.equal(searches.length, count);
  assert.equal(downloads.length, 0);
});
