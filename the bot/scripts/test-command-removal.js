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

const retired = ['x', 'twitter', 'xtwitter', 'reddit', 'spotify', 'audius', 'deezer', 'dz', 'bilibili', 'bili', 'vimeo', 'dailymotion', 'daily',
  'xhs', 'xiaohongshu', 'acfun', 'twitch', 'rumble', 'niconico', 'nico', 'commons',
  'broadcast', 'bc', 'announce', 'weibo', 'pinterest', 'pintrest', 'pin', 'douyin', 'odysee', 'vk', 'youku',
  'ytv', 'ytvideo', 'dl', 'download', 'save', 'getvid', 'fetch'];

test('retired commands and their aliases are not registered or listed in the menus', () => {
  const commands = bot('gateway/registry').loadCommands();
  for (const name of retired) assert.equal(commands.has(name), false, `${name} unexpectedly registered`);
  for (const name of ['song', 'video', 'ytmp4', 'tiktok', 'instagram', 'fb', 'dramabox', 'drama', 'dramastream', 'status', 'restart']) {
    assert.ok(commands.has(name), `${name} must remain registered`);
  }
  assert.equal(fs.existsSync(path.join(root, 'commands/media/dl.js')), false, '.dl source still exists');
  assert.equal(fs.existsSync(path.join(root, 'commands/media/ytv.js')), false, '.ytv source still exists');
  const menu = bot('commands/menu/index');
  for (const isOwner of [false, true]) {
    const text = menu._buildCard(menu._buildGroups('.', { isOwner }), null, { prefix: '.' });
    for (const name of retired) assert.doesNotMatch(text, new RegExp(`(^|\\s)\\.${name}(?![a-z0-9_])`, 'im'));
  }
});

test('a legacy environment credential cannot divert XJX song title searches', async () => {
  const youtube = bot('lib/youtube/search');
  const xjxMedia = bot('lib/downloads/xjx');
  const song = bot('commands/song/index');
  const savedSearch = youtube.searchYouTube;
  const savedSend = xjxMedia.downloadSongCommand;
  const songRequests = [];
  const socket = { async sendMessage() {} };
  const msg = { key: { remoteJid: 'test@s.whatsapp.net', id: 'fixture' }, message: {} };
  const extra = { from: 'test@s.whatsapp.net', isOwner: true, status: async () => ({ update: async () => {} }) };
  try {
    youtube.searchYouTube = async () => [];
    xjxMedia.downloadSongCommand = async (_sock, _msg, _extra, input) => { songRequests.push(input); return { sent: true }; };
    await song.execute(socket, msg, ['Example', 'Song'], extra);
    assert.deepEqual(songRequests, ['Example Song']);
    assert.equal(Object.hasOwn(bot('config'), 'deezer'), false);
    assert.equal(Object.hasOwn(bot('config'), 'spotify'), false);
  } finally {
    youtube.searchYouTube = savedSearch;
    xjxMedia.downloadSongCommand = savedSend;
  }
});

test('WhatsApp broadcast and status identifiers remain protected', () => {
  const jid = bot('lib/jid');
  assert.equal(jid.isSystemJid('status@broadcast'), true);
});
