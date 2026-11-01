'use strict';

// Regression guard: removed commands and aliases must not return, while the
// remaining music/video commands keep their normal title-search behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-commands-'));
const root = createBotFixture(temp);
process.chdir(temp);
// Existing deployments may still contain a legacy credential in their .env.
// Synthetic only: do not read or modify the deployed host's configuration.
process.env.DEEZER_ARL = 'syntheticLegacyCredential12345';
const bot = (name) => require(path.join(root, name));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const retired = ['audius', 'deezer', 'dz', 'bilibili', 'bili', 'vimeo', 'dailymotion', 'daily',
  'xhs', 'xiaohongshu', 'acfun', 'twitch', 'rumble', 'niconico', 'nico', 'commons',
  'broadcast', 'bc', 'announce', 'weibo', 'pinterest', 'pintrest', 'pin', 'douyin', 'odysee', 'vk', 'youku'];

test('retired commands and their aliases are not registered or listed in the menus', () => {
  const commands = bot('utils/commandLoader').loadCommands();
  for (const name of retired) assert.equal(commands.has(name), false, `${name} unexpectedly registered`);
  for (const name of ['song', 'ytv', 'dl', 'spotify', 'reddit', 'tiktok', 'x', 'instagram', 'fb', 'status', 'restart']) {
    assert.ok(commands.has(name), `${name} must remain registered`);
  }
  const menu = bot('commands/general/menu');
  for (const isOwner of [false, true]) {
    const text = menu._buildCard(menu._buildGroups('.', { isOwner }), null, { prefix: '.' });
    for (const name of retired) assert.doesNotMatch(text, new RegExp(`\\.${name}(?![a-z0-9_])`, 'i'));
  }
});

test('a legacy environment credential cannot divert song or Spotify title searches', async () => {
  const youtube = bot('utils/youtubeSearch');
  const spotify = bot('utils/spotify');
  const song = bot('commands/media/song');
  const spotifyCommand = bot('commands/media/spotify');
  const savedSearch = youtube.searchYouTube;
  const savedResolve = spotify.resolveTrack;
  const queries = [];
  const messages = [];
  const socket = { async sendMessage(_chat, body) { if (body.text) messages.push(body.text); } };
  const msg = { key: { remoteJid: 'test@s.whatsapp.net', id: 'fixture' }, message: {} };
  const extra = { from: 'test@s.whatsapp.net', isOwner: true, status: async () => ({ update: async (text) => messages.push(text) }) };
  try {
    youtube.searchYouTube = async (query) => { queries.push(query); return []; };
    spotify.resolveTrack = async () => ({ title: 'Track', artists: 'Artist', searchQuery: 'Artist Track', source: 'query' });
    await song.execute(socket, msg, ['Example', 'Song'], extra);
    await spotifyCommand.execute(socket, msg, ['Artist', 'Track'], extra);
    assert.deepEqual(queries, ['Example Song', 'Artist Track']);
    assert.ok(messages.some((message) => /No results found/i.test(message)));
    assert.ok(messages.some((message) => /Not found/i.test(message)));
    assert.equal(Object.hasOwn(bot('config'), 'deezer'), false);
  } finally {
    youtube.searchYouTube = savedSearch;
    spotify.resolveTrack = savedResolve;
  }
});

test('WhatsApp broadcast and status identifiers remain protected', () => {
  const jid = bot('utils/jid');
  assert.equal(jid.isSystemJid('status@broadcast'), true);
});
