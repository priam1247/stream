#!/usr/bin/env node
'use strict';

// Offline coverage for the XJX .dramabox route and command delivery.
// The Keith API and WhatsApp socket are mocked; this suite makes no network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xjx-dramabox-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
process.env.PREFIX = '.';

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const dramabox = require(path.join(ROOT, 'commands/dramabox/source'));

function fakeHttp(responder) {
  const calls = [];
  return {
    calls,
    http: {
      async get(url, options) {
        calls.push({ url, options });
        return responder(url, options, calls.length - 1);
      },
    },
  };
}

test('DramaBox follows XJX /dramabox/stream with bookId and default episode 1', async () => {
  const { http, calls } = fakeHttp(async (url, options) => {
    assert.equal(url, `${dramabox.constants.API_BASE}${dramabox.constants.API_PATH}`);
    assert.deepEqual(options.params, { bookId: '41000105764', episode: 1 });
    assert.equal(options.timeout, dramabox.constants.DEFAULT_TIMEOUT_MS);
    return { data: { success: true, data: {
      streamUrl: 'https://cdn.example.org/episode-1.m3u8',
      title: 'Sample Drama', quality: '720p',
    } } };
  });
  const client = dramabox.createXjxDramaBox({ http });
  const result = await client.getDramaBoxStream('41000105764');
  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    url: 'https://cdn.example.org/episode-1.m3u8',
    title: 'Sample Drama', quality: '720p', responseText: '',
  });
});

test('DramaBox honors an explicit episode and accepts the XJX string response shape', async () => {
  const { http, calls } = fakeHttp(async (_url, options) => {
    assert.deepEqual(options.params, { bookId: 'book_42', episode: 12 });
    return { data: { success: true, data: 'https://cdn.example.org/episode-12.mp4' } };
  });
  const client = dramabox.createXjxDramaBox({ http });
  const result = await client.getDramaBoxStream('book_42', 12);
  assert.equal(calls.length, 1);
  assert.equal(result.url, 'https://cdn.example.org/episode-12.mp4');
});

test('DramaBox rejects invalid IDs, invalid episodes, and unsafe returned URLs', async () => {
  let requests = 0;
  const client = dramabox.createXjxDramaBox({
    http: { async get() { requests++; return { data: { data: { url: 'http://127.0.0.1/private.m3u8' } } }; } },
  });
  await assert.rejects(client.getDramaBoxStream('../private'), { code: 'BAD_INPUT' });
  await assert.rejects(client.getDramaBoxStream('41000105764', 0), { code: 'BAD_INPUT' });
  await assert.rejects(client.getDramaBoxStream('41000105764', '1e3'), { code: 'BAD_INPUT' });
  await assert.rejects(client.getDramaBoxStream('41000105764'), { code: 'UNSAFE_URL' });
  assert.equal(requests, 1, 'invalid input must not reach the API');
});

test('DramaBox maps API failures to safe error codes', async () => {
  const failed = dramabox.createXjxDramaBox({
    http: { async get() { return { data: { success: false, message: 'private fixture detail' } }; } },
  });
  await assert.rejects(failed.getDramaBoxStream('41000105764'), { code: 'PROVIDER_FAILED' });

  const unavailable = dramabox.createXjxDramaBox({
    http: { async get() { throw Object.assign(new Error('raw service detail'), { response: { status: 503 } }); } },
  });
  await assert.rejects(unavailable.getDramaBoxStream('41000105764'), (error) => {
    assert.equal(error.code, 'HTTP_503');
    assert.doesNotMatch(error.message, /raw service detail/);
    return true;
  });
});

test('.dramabox command is registered, routes the request, and sends a stream link', async () => {
  const commands = require(path.join(ROOT, 'gateway/registry')).loadCommands();
  const command = commands.get('dramabox');
  assert.ok(command);
  assert.equal(commands.get('drama'), command);
  assert.equal(commands.get('dramastream'), command);

  const menu = require(path.join(ROOT, 'commands/menu/index'));
  const card = menu._buildCard(menu._buildGroups('.', { isOwner: false }));
  assert.match(card, /\.dramabox <bookId> \[episode\]/);

  const original = dramabox.getDramaBoxStream;
  const calls = [];
  const sent = [];
  dramabox.getDramaBoxStream = async (bookId, episode) => {
    calls.push({ bookId, episode });
    return {
      url: 'https://cdn.example.org/episode.m3u8', title: 'Sample Drama',
      quality: '1080p', responseText: '',
    };
  };
  const sock = {
    async sendMessage(_chat, body) { sent.push(body); return {}; },
  };
  const msg = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'fixture' } };
  const extra = { from: msg.key.remoteJid, reply: async (text) => { sent.push({ text }); } };
  try {
    await command.execute(sock, msg, ['41000105764', '3'], extra);
  } finally {
    dramabox.getDramaBoxStream = original;
  }

  assert.deepEqual(calls, [{ bookId: '41000105764', episode: 3 }]);
  assert.ok(sent.some((body) => /https:\/\/cdn\.example\.org\/episode\.m3u8/.test(body.text || '')));
  assert.ok(sent.some((body) => body.react?.text === '🎭'));
});
