#!/usr/bin/env node
'use strict';

// Offline tests for the Gronka-only Facebook/Instagram resolvers and delivery.
// Gronka answers and WhatsApp sends are mocked; this suite makes no network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'social-media-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
process.env.PREFIX = '.';

const social = require(path.join(ROOT, 'commands/social/socialMedia'));
const { createSocialMedia } = social;
const sampleFacebook = 'https://www.facebook.com/share/r/fixture/';
const sampleInstagram = 'https://www.instagram.com/reel/fixture/';

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fakeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(_chat, body, options) {
      sent.push({ body, options });
      return { key: { id: `sent-${sent.length}` } };
    },
  };
}

const gk = (handler) => ({ enabled: true, async download(url, options) { return handler(url, options); } });
const fbResult = { lane: 'worker', files: [{ url: 'https://dl.gronka.dev/f/fb', filename: 'Clip.video.mp4', kind: 'video' }] };

test('Facebook: one Gronka request, links from other sites are refused before any request', async () => {
  const asked = [];
  const client = createSocialMedia({ gronka: gk((url, options) => { asked.push({ url, options }); return fbResult; }), logger: { warn() {} } });
  const hit = await client.resolveFacebook(sampleFacebook);
  assert.equal(hit.url, 'https://dl.gronka.dev/f/fb');
  assert.equal(hit.kind, 'video');
  assert.deepEqual(asked.map((a) => [a.url, a.options.mode]), [[sampleFacebook, 'auto']]);
  await assert.rejects(client.resolveFacebook('https://example.org/video'), (e) => e.code === 'BAD_LINK');
  assert.equal(asked.length, 1, 'no request for a refused link');
});

test('Instagram: ddinstagram links are rewritten, and unsafe or private media URLs are dropped', async () => {
  const asked = [];
  const client = createSocialMedia({
    gronka: gk((url) => {
      asked.push(url);
      return { lane: 'direct', files: [
        { url: 'http://127.0.0.1/secret.jpg', filename: 'x.jpg', type: 'image' },
        { url: 'https://cdninstagram.com/ok.jpg', filename: 'ok.jpg', type: 'image' },
      ] };
    }),
    logger: { warn() {} },
  });
  const items = await client.resolveInstagram('https://www.ddinstagram.com/p/abc/');
  assert.equal(asked[0], 'https://www.instagram.com/p/abc/');
  assert.deepEqual(items.map((i) => i.url), ['https://cdninstagram.com/ok.jpg']);
  const onlyPrivate = createSocialMedia({ gronka: gk(() => ({ lane: 'direct', files: [{ url: 'http://10.0.0.5/a.mp4', type: 'video' }] })), logger: { warn() {} } });
  await assert.rejects(onlyPrivate.resolveInstagram(sampleInstagram), (e) => e.code === 'NO_MEDIA');
});

test('downloadAndSend reacts, sends every item, and reports a failure honestly', async () => {
  const sock = fakeSock();
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'm1' } };
  const ok = createSocialMedia({
    gronka: gk(() => ({ lane: 'r2', files: [
      { url: 'https://cdn.gronka.dev/a.jpg', filename: 'a.jpg', type: 'image' },
      { url: 'https://cdn.gronka.dev/b.mp4', filename: 'b.mp4', type: 'video' },
    ] })),
    logger: { warn() {} },
  });
  const result = await ok.downloadAndSend(sock, msg, { from: msg.key.remoteJid }, { platform: 'instagram', url: sampleInstagram });
  assert.equal(result.count, 2);
  assert.ok(sock.sent.some((x) => x.body.image) && sock.sent.some((x) => x.body.video));
  assert.ok(sock.sent.some((x) => x.body.react?.text === '✅'));

  const failing = createSocialMedia({ gronka: gk(() => { throw Object.assign(new Error('x'), { code: 'CONTENT_GONE', userMessage: 'That post was deleted.' }); }), logger: { warn() {} } });
  const sock2 = fakeSock();
  await assert.rejects(failing.downloadAndSend(sock2, msg, { from: msg.key.remoteJid }, { platform: 'facebook', url: sampleFacebook }), (e) => e.code === 'CONTENT_GONE');
  assert.ok(sock2.sent.some((x) => x.body.react?.text === '❌'));
  assert.equal(sock2.sent.some((x) => x.body.video || x.body.image), false);
});

test('without GRONKA_API_KEY Facebook and Instagram say so instead of trying anything else', async () => {
  const client = createSocialMedia({ gronka: { enabled: false, async download() { throw new Error('must not be called'); } }, logger: { warn() {} } });
  await assert.rejects(client.resolveFacebook(sampleFacebook), (e) => e.code === 'NOT_CONFIGURED' && /GRONKA_API_KEY/.test(e.userMessage));
  await assert.rejects(client.resolveInstagram(sampleInstagram), (e) => e.code === 'NOT_CONFIGURED');
  assert.match(social.friendlyError({ code: 'BAD_LINK' }, 'facebook'), /Facebook/);
});

test('shortcuts route .fb and .ig through social resolvers, not yt-dlp/Cobalt', async () => {
  const calls = [];
  const previous = social.downloadAndSend;
  social.downloadAndSend = async (_sock, _msg, _extra, options) => {
    calls.push(options);
    return { sent: true };
  };
  try {
    const commands = require(path.join(ROOT, 'commands/social/index'));
    const find = (name) => commands.find((command) => command.name === name || command.aliases.includes(name));
    const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'social-route' }, message: {} };
    const extra = { from: msg.key.remoteJid };
    const sock = { async sendMessage() { return {}; } };

    await find('fb').execute(sock, msg, [sampleFacebook, '480'], extra);
    await find('ig').execute(sock, msg, [sampleInstagram], extra);
    assert.deepEqual(calls.map(({ platform }) => platform), ['facebook', 'instagram']);
    assert.equal(calls[0].url, sampleFacebook);
    assert.equal(calls[0].quality, 480);
    assert.equal(calls[1].url, sampleInstagram);
  } finally {
    social.downloadAndSend = previous;
  }
});

// ─── Gronka API (single source for Facebook and Instagram when enabled) ─────
test('Facebook and Instagram use Gronka only, and a Gronka failure is reported as is', async () => {
  const touched = [];
  const never = { async get() { touched.push('http'); throw new Error('no'); } };
  const gronka = {
    enabled: true,
    async download(url) {
      if (/facebook/.test(url)) return { lane: 'worker', files: [{ url: 'https://dl.gronka.dev/f/fb', filename: 'Clip.video.mp4', kind: 'video' }] };
      return { lane: 'r2', files: [
        { url: 'https://cdn.gronka.dev/a.jpg', filename: 'a.jpg', type: 'image' },
        { url: 'https://cdn.gronka.dev/b.mp4', filename: 'b.mp4', type: 'video' },
        { url: 'https://cdn.gronka.dev/c.m4a', filename: 'c.m4a', kind: 'audio' },
        { url: 'https://cdn.gronka.dev/d.png', filename: 'd.png', kind: 'file' },
      ] };
    },
  };
  const client = createSocialMedia({ gronka, logger: { warn() {} } });
  const fb = await client.resolveFacebook(sampleFacebook);
  assert.equal(fb.url, 'https://dl.gronka.dev/f/fb');
  assert.equal(fb.kind, 'video');
  const ig = await client.resolveInstagram(sampleInstagram);
  assert.deepEqual(ig.map((i) => i.kind), ['image', 'video', 'image']);
  assert.equal(ig[2].mimeType, 'image/png');
  assert.deepEqual(touched, [], 'no other provider may be contacted');

  const broken = { enabled: true, async download() { throw Object.assign(new Error('x'), { code: 'CONTENT_GONE', userMessage: 'That post was deleted.' }); } };
  const strict = createSocialMedia({ gronka: broken, logger: { warn() {} } });
  await assert.rejects(strict.resolveInstagram(sampleInstagram), (e) => e.code === 'CONTENT_GONE');
  assert.equal(social.friendlyError({ userMessage: 'That post was deleted.' }, 'instagram'), '❌ That post was deleted.');
  assert.deepEqual(touched, []);
});
