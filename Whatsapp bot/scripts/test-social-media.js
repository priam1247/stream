#!/usr/bin/env node
'use strict';

// Offline tests for the XJX-style Facebook/Instagram resolvers and delivery.
// Provider responses and WhatsApp sends are mocked; this suite makes no network calls.
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

const social = require(path.join(ROOT, 'utils/socialMedia'));
const { createSocialMedia, constants } = social;
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

test('Facebook follows XJX ApisSupreme flow, uses the owned key, and prefers HD', async () => {
  const calls = [];
  const client = createSocialMedia({
    http: { async get(url, options) {
      calls.push({ url, options });
      return { data: { success: true, data: { videos: {
        hd: 'https://cdn.example.org/facebook-hd.mp4',
        sd: 'https://cdn.example.org/facebook-sd.mp4',
      } } } };
    } },
    settings: { apissupremeApiKey: 'fixture-private-key', timeoutMs: 3000 },
    logger: { warn() {} },
  });
  const sock = fakeSock();
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'fb-1' } };
  const result = await client.downloadAndSend(sock, msg, { from: msg.key.remoteJid }, {
    platform: 'facebook', url: sampleFacebook,
  });

  assert.equal(result.sent, true);
  assert.equal(calls[0].url, constants.FACEBOOK_API);
  assert.equal(calls[0].options.params.url, sampleFacebook);
  assert.equal(calls[0].options.params.apikey, 'fixture-private-key');
  assert.equal(calls[0].options.timeout, 3000);
  const media = sock.sent.filter(({ body }) => body.video || body.image || body.document);
  assert.equal(media.length, 1);
  assert.equal(media[0].body.video.url, 'https://cdn.example.org/facebook-hd.mp4');
});

test('Facebook respects a low requested quality and safely falls back to SD', async () => {
  const client = createSocialMedia({
    http: { async get() { return { data: { success: true, data: { videos: {
      hd: 'http://127.0.0.1/private.mp4',
      sd: 'https://cdn.example.org/facebook-sd.mp4',
    } } } }; } },
    settings: {}, logger: { warn() {} },
  });
  const hit = await client.resolveFacebook(sampleFacebook, { quality: 480 });
  assert.equal(hit.url, 'https://cdn.example.org/facebook-sd.mp4');
  await assert.rejects(client.resolveFacebook('https://example.org/not-facebook'), { code: 'BAD_LINK' });
});

test('Instagram uses the XJX ruhend-scraper result shape, deduplicates, and sends carousel items', async () => {
  const calls = [];
  const client = createSocialMedia({
    instagramDownload: async (url) => {
      calls.push(url);
      return { result: [
        { url: 'https://cdninstagram.com/clip.mp4?token=fixture', type: 'video' },
        { url: 'https://cdninstagram.com/photo.jpg?token=fixture', type: 'image' },
        { url: 'https://cdninstagram.com/photo.jpg?token=fixture', type: 'image' },
      ] };
    },
    settings: {}, logger: { warn() {} },
  });
  const sock = fakeSock();
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'ig-1' } };
  const result = await client.downloadAndSend(sock, msg, { from: msg.key.remoteJid }, {
    platform: 'instagram', url: sampleInstagram,
  });

  assert.equal(calls[0], sampleInstagram);
  assert.equal(result.count, 2);
  const media = sock.sent.filter(({ body }) => body.video || body.image);
  assert.deepEqual(media.map(({ body }) => body.video ? 'video' : 'image'), ['video', 'image']);
  assert.equal(media[0].body.video.url, 'https://cdninstagram.com/clip.mp4?token=fixture');
  assert.equal(media[1].body.image.url, 'https://cdninstagram.com/photo.jpg?token=fixture');
});

test('Instagram rewrites ddinstagram and refuses private or unsafe result URLs', async () => {
  const requested = [];
  const client = createSocialMedia({
    instagramDownload: async (url) => {
      requested.push(url);
      return { result: [{ url: 'http://127.0.0.1/private.mp4', type: 'video' }] };
    },
    settings: {}, logger: { warn() {} },
  });
  await assert.rejects(client.resolveInstagram('https://ddinstagram.com/reel/fixture/'), { code: 'NO_MEDIA' });
  assert.equal(new URL(requested[0]).hostname, 'www.instagram.com');
  await assert.rejects(client.resolveInstagram('https://example.org/reel/fixture/'), { code: 'BAD_LINK' });
});

test('shortcuts route .fb and .ig through social resolvers, not yt-dlp/Cobalt', async () => {
  const calls = [];
  const previous = social.downloadAndSend;
  social.downloadAndSend = async (_sock, _msg, _extra, options) => {
    calls.push(options);
    return { sent: true };
  };
  try {
    const commands = require(path.join(ROOT, 'commands/media/shortcuts'));
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
