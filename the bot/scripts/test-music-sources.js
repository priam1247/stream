#!/usr/bin/env node
'use strict';

/**
 * Offline tests for the keyless music sources.
 *
 * Every HTTP response is a fixture installed through
 * utils/musicSources/http.setTransportForTests — no WhatsApp connection and no
 * network access. Commands are exercised against stubbed delivery so the
 * existing .song / .video command behavior is guarded too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('zlib');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'music-sources-'));
const BOT = createBotFixture(TMP);
const bot = createRequire(path.join(BOT, 'scripts', 'test-music-sources.js'));
process.chdir(TMP);

const http = bot('../lib/music/http');
const C = bot('../lib/music/constants');
const sources = bot('../lib/music');
const deezer = bot('../lib/music/deezer');
const itunes = bot('../lib/music/itunes');
const spotify = bot('../lib/music/spotifyEmbed');
const soundcloud = bot('../lib/music/soundcloud');
const lyrics = bot('../lib/music/lyrics');
const youtubeMusic = bot('../lib/music/youtubeMusic');
const mediaTransfer = bot('../lib/mediaTransfer');
const youtubeSearch = bot('../lib/youtube/search');
const mediaPipeline = bot('../lib/downloads/pipeline');
const selections = bot('../lib/selections');
const deliver = bot('../lib/music/deliver');
const config = bot('../config');
const { loadCommands } = bot('../gateway/registry');

const json = (data, status = 200) => ({
  status,
  body: typeof data === 'string' ? data : JSON.stringify(data ?? {}),
});
const html = (body) => ({ status: 200, body });

let routes = [];
const route = (matcher, responder) => routes.push([matcher, responder]);
http.setTransportForTests(async (url, opts) => {
  let parsed;
  try { parsed = new URL(url); } catch { return json({}, 400); }
  for (const [matcher, responder] of routes) {
    if (!matcher(url, parsed, opts)) continue;
    const result = await responder(url, parsed, opts);
    if (result && typeof result === 'object' && ('status' in result || 'body' in result)) return result;
    return json(result);
  }
  return json({}, 404);
});

test.beforeEach(() => {
  routes = [];
  soundcloud._resetForTests();
});
test.after(() => {
  http.setTransportForTests(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const socket = () => ({
  sent: [],
  async sendMessage(_chat, content) {
    this.sent.push(content);
    return { key: { id: `msg-${this.sent.length}` } };
  },
});
const message = () => ({ key: { remoteJid: 'test@s.whatsapp.net', id: 'm1' }, message: {} });
const extra = () => ({
  from: 'test@s.whatsapp.net', isOwner: true,
  status: async () => ({ update: async () => {} }),
});

// ─── 1. Link recognition ───────────────────────────────────────────────────

test('recognises keyless music links but leaves ordinary YouTube links alone', () => {
  assert.equal(sources.isMusicLink('https://www.deezer.com/track/3135556'), true);
  assert.equal(sources.isMusicLink('https://music.apple.com/us/album/xyz/123?i=456'), true);
  assert.equal(sources.isMusicLink('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), true);
  assert.equal(sources.isMusicLink('https://soundcloud.com/artist/track'), true);
  assert.equal(sources.isMusicLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(sources.isMusicLink('Alan Walker Faded'), false);
  assert.equal(
    sources.normalizeDirectUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  assert.equal(sources.normalizeDirectUrl('https://music.youtube.com/playlist?list=PL12345678'),
    'https://www.youtube.com/playlist?list=PL12345678');
  assert.equal(youtubeMusic.normalize('https://music.youtube.com/browse/MPREb_xyz'), null);
  assert.equal(sources.isMusicLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(sources.normalizeDirectUrl('https://music.youtube.com/browse/MPREb_xyz'), null);
});

test('unsupported YouTube Music browse pages are not handed to yt-dlp', async () => {
  assert.equal(await sources.resolveUrl('https://music.youtube.com/browse/MPREb_xyz'), null);
});

test('the HTTP client refuses non-https and unexpected hosts', () => {
  assert.throws(() => http.assertSafe('http://api.deezer.com/track/1'), /https/i);
  assert.throws(() => http.assertSafe('https://evil.example.com/'), /Host not allowed/);
  assert.throws(() => http.assertSafe('https://user:pw@api.deezer.com/'), /credentials/);
  assert.doesNotThrow(() => http.assertSafe('https://api.deezer.com/track/1'));
});

// ─── 2. Deezer ─────────────────────────────────────────────────────────────

test('Deezer track link resolves to a normalized track', async () => {
  route((url, u) => u.hostname === 'api.deezer.com' && u.pathname === '/track/3135556', () => json({
    id: 3135556, title: 'Harder Better Faster Stronger',
    artist: { name: 'Daft Punk' },
    album: { title: 'Discovery', cover_big: 'https://cdn-images.dzcdn.net/cover.jpg' },
    duration: 224, preview: 'https://api.deezer.com/preview.mp3',
    link: 'https://www.deezer.com/track/3135556',
  }));
  const out = await sources.resolveUrl('https://www.deezer.com/track/3135556');
  assert.equal(out.type, 'collection');
  assert.equal(out.collection.source, 'deezer');
  assert.equal(out.collection.tracks.length, 1);
  const track = out.collection.tracks[0];
  assert.equal(track.title, 'Harder Better Faster Stronger');
  assert.deepEqual(track.artists, ['Daft Punk']);
  assert.equal(track.durationMs, 224000);
  assert.match(track.cover, /dzcdn/);
});

test('Deezer album pagination follows the absolute next URL', async () => {
  route((url, u) => u.pathname === '/album/42', () => json({
    id: 42, title: 'Discovery', artist: { name: 'Daft Punk' },
    cover_big: 'https://cdn-images.dzcdn.net/cover.jpg', release_date: '2001-03-12',
    tracks: { data: [{ id: 1, title: 'One More Time', duration: 320, artist: { name: 'Daft Punk' } }], next: 'https://api.deezer.com/album/42/tracks?index=1' },
  }));
  route((url, u) => u.pathname === '/album/42/tracks', () => json({
    data: [{ id: 2, title: 'Aerodynamic', duration: 213, artist: { name: 'Daft Punk' } }], next: '',
  }));
  const out = await deezer.resolve('https://www.deezer.com/album/42');
  assert.equal(out.kind, 'album');
  assert.deepEqual(out.tracks.map((t) => t.title), ['One More Time', 'Aerodynamic']);
  assert.equal(out.tracks[0].album, 'Discovery');
  assert.equal(out.tracks[0].trackNumber, 1);
});

test('Deezer search fans out and returns typed results', async () => {
  route((url, u) => u.pathname === '/search/track', () => json({ data: [
    { id: 1, title: 'Faded', artist: { name: 'Alan Walker' }, duration: 212, link: 'https://www.deezer.com/track/1' },
  ] }));
  route((url, u) => u.pathname === '/search/album', () => json({ data: [] }));
  route((url, u) => u.pathname === '/search/artist', () => json({ data: [] }));
  route((url, u) => u.pathname === '/search/playlist', () => json({ data: [] }));
  const rows = await deezer.search('Faded', { limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'deezer');
  assert.equal(rows[0].durationMs, 212000);
});

// ─── 3. iTunes / Apple Music ───────────────────────────────────────────────

test('Apple Music album ?i= link resolves the individual song', async () => {
  assert.deepEqual(itunes.parseUrl('https://music.apple.com/us/album/xyz/123?i=456'), { kind: 'song', id: '456' });
  route((url, u) => u.pathname === '/lookup', () => json({ results: [
    { wrapperType: 'track', trackId: 456, trackName: 'Song', artistName: 'Artist',
      collectionName: 'Album', trackTimeMillis: 200000, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100.jpg',
      trackViewUrl: 'https://music.apple.com/us/album/xyz/123?i=456' },
  ] }));
  const out = await sources.resolveUrl('https://music.apple.com/us/album/xyz/123?i=456');
  assert.equal(out.collection.kind, 'track');
  assert.equal(out.collection.tracks[0].title, 'Song');
  assert.equal(out.collection.tracks[0].durationMs, 200000);
  assert.match(out.collection.tracks[0].cover, /600x600/);
});

test('iTunes lookup expands an album into its tracks', async () => {
  route((url, u) => u.pathname === '/lookup', () => json({ results: [
    { wrapperType: 'collection', collectionType: 'Album', collectionName: 'Album', artistName: 'Artist' },
    { wrapperType: 'track', trackId: 1, trackName: 'First', artistName: 'Artist', trackTimeMillis: 100000, trackNumber: 1 },
    { wrapperType: 'track', trackId: 2, trackName: 'Second', artistName: 'Artist', trackTimeMillis: 120000, trackNumber: 2 },
  ] }));
  const out = await itunes.resolve('https://music.apple.com/us/album/album/123');
  assert.equal(out.kind, 'album');
  assert.deepEqual(out.tracks.map((t) => t.title), ['First', 'Second']);
});

// ─── 4. Spotify embed ──────────────────────────────────────────────────────

const embedHtml = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${
  JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })
}</script></html>`;

test('Spotify embed track resolves without a token', async () => {
  route((url, u) => u.pathname === '/embed/track/abc', () => html(embedHtml({
    name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], duration: 200000,
    albumOfTrack: { name: 'After Hours' },
    visualIdentity: { image: [{ maxWidth: 640, url: 'https://i.scdn.co/image/cover.jpg' }] },
    releaseDate: { isoString: '2020-03-20' },
    audioPreview: { url: 'https://open.spotify.com/preview.mp3' },
  })));
  const out = await sources.resolveUrl('https://open.spotify.com/track/abc');
  assert.equal(out.collection.source, 'spotify');
  assert.equal(out.collection.tracks[0].title, 'Blinding Lights');
  assert.equal(out.collection.tracks[0].durationMs, 200000);
  assert.equal(out.collection.tracks[0].releaseDate, '2020');
  assert.match(out.collection.tracks[0].cover, /scdn/);
});

test('Spotify playlist tail is best-effort when the anonymous token answers', async () => {
  const tracks = Array.from({ length: C.SPOTIFY_EMBED_CAP }, (_, i) => ({ title: `Track ${i}` }));
  route((url, u) => u.pathname === '/embed/api/token', () => json({ accessToken: 'anonymous' }));
  route((url, u) => u.pathname === '/pathfinder/v1/query', () => json({
    data: { playlistV2: { content: { totalCount: 101, items: [
      { itemV2: { __typename: 'TrackResponseWrapper', data: {
        uri: 'spotify:track:tail', name: 'Tail Track',
        trackDuration: { totalMilliseconds: 180000 },
        artists: { items: [{ profile: { name: 'Tail Artist' } }] },
        albumOfTrack: { name: 'Tail Album', date: { isoString: '2021-01-01' } },
      } } },
    ] } } },
  }));
  const extended = await spotify.extendPlaylist(tracks, 'pl');
  assert.equal(extended.length, C.SPOTIFY_EMBED_CAP + 1);
  assert.equal(extended.at(-1).title, 'Tail Track');
  assert.equal(extended.at(-1).artists[0], 'Tail Artist');
});

// ─── 5. SoundCloud ─────────────────────────────────────────────────────────

test('SoundCloud client id is scraped from a public bundle and used for /resolve', async () => {
  const id32 = 'abcdefghijklmnopqrstuvwxyz012345';
  route((url, u) => u.hostname === 'soundcloud.com' && u.pathname === '/', () => html(
    '<html><script src="https://a-v2.sndcdn.com/assets/50-a.js"></script></html>',
  ));
  route((url, u) => u.hostname === 'a-v2.sndcdn.com', () => html(
    `window.x={client_id:"${id32}"};`,
  ));
  route((url, u) => u.hostname === 'api-v2.soundcloud.com' && u.pathname === '/resolve', (url, u) => {
    assert.equal(u.searchParams.get('client_id'), id32);
    return json({ kind: 'track', id: 7, title: 'Cloud Song', duration: 150000,
      user: { username: 'Cloud Artist' }, permalink_url: 'https://soundcloud.com/a/cloud-song',
      artwork_url: 'https://i1.sndcdn.com/art-large.jpg' });
  });
  const out = await sources.resolveUrl('https://soundcloud.com/a/cloud-song');
  assert.equal(out.collection.source, 'soundcloud');
  assert.equal(out.collection.tracks[0].title, 'Cloud Song');
  assert.equal(out.collection.tracks[0].durationMs, 150000);
});

// ─── 6. Lyrics ─────────────────────────────────────────────────────────────

test('Kugou lyrics decode: base64 → drop header → XOR → inflate', () => {
  const plain = 'first line\nsecond line';
  const compressed = zlib.deflateSync(Buffer.from(plain, 'utf8'));
  const xored = Buffer.from(compressed);
  for (let i = 0; i < xored.length; i++) xored[i] ^= C.KUGOU_CIPHER[i % 16];
  const content = Buffer.concat([Buffer.alloc(4), xored]).toString('base64');
  assert.equal(lyrics.decodeKugou(content), plain);
  assert.equal(lyrics.stripTimestamps('[00:12.00]hello [123,45]world'), 'hello world');
});

test('LRCLIB wins; a miss falls through to Netease', async () => {
  const track = { title: 'Song', artists: ['Artist'], album: 'Album', durationMs: 200000, cover: '' };
  route((url, u) => u.pathname === '/api/get', () => json({
    plainLyrics: 'these are the words', syncedLyrics: '[00:01.00]these are the words',
  }));
  assert.equal((await lyrics.getLyrics(track)).source, 'lrclib-get');

  routes = [];
  route((url, u) => u.pathname === '/api/get', () => json({}, 404));
  route((url, u) => u.pathname === '/api/search', () => json([]));
  route((url, u, opts) => u.pathname === '/api/search/get' && /s=/.test(String(opts?.body || '')), () => json({
    result: { songs: [{ id: 99, name: 'Song' }] },
  }));
  route((url, u) => u.pathname === '/api/song/lyric/v1', () => json({
    lrc: { lyric: '[00:01.00]netease words\n[00:05.00]more words' },
  }));
  const fallback = await lyrics.getLyrics(track);
  assert.equal(fallback.source, 'netease');
  assert.match(fallback.plain, /netease words/);
});

// ─── 7. Duration matching + merged search ──────────────────────────────────

test('pickBest prefers the duration within the ±20s window', () => {
  const rows = [
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Song (1 hour mix)', duration: 3600 },
    { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Song', duration: 213 },
    { url: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'Song', duration: 195 },
  ];
  assert.equal(sources.pickBest(rows, 213000).url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
  // Without a catalog duration the hour-long mix is still refused.
  assert.notEqual(sources.pickBest(rows, 0).url, rows[0].url);
});

test('video mode prefers an official upload on equal duration', () => {
  const rows = [
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Song (lyrics)', duration: 200 },
    { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Song (Official Music Video)', duration: 201 },
  ];
  assert.equal(sources.pickBest(rows, 200000, { video: true }).url,
    'https://www.youtube.com/watch?v=bbbbbbbbbbb');
});

test('searchAll merges providers, dedupes and ranks by relevance', async () => {
  const saved = {
    deezer: sources.deezer.search,
    itunes: sources.itunes.search,
    soundcloud: sources.soundcloud.search,
    yt: youtubeSearch.searchYouTube,
  };
  try {
    sources.deezer.search = async () => [
      { source: 'deezer', kind: 'track', name: 'Faded', subtitle: 'Alan Walker', url: 'https://www.deezer.com/track/1', durationMs: 212000, cover: '' },
    ];
    sources.itunes.search = async () => [
      { source: 'itunes', kind: 'track', name: 'Faded', subtitle: 'Alan Walker', url: 'https://music.apple.com/us/album/x/1?i=2', durationMs: 212000, cover: '' },
      { source: 'itunes', kind: 'track', name: 'Faded (Remix)', subtitle: 'Alan Walker', url: 'https://music.apple.com/us/album/x/1?i=3', durationMs: 230000, cover: '' },
    ];
    sources.soundcloud.search = async () => [];
    youtubeSearch.searchYouTube = async () => [
      { url: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'Faded (Live)', author: 'Alan Walker', duration: 212, thumbnail: '' },
    ];
    const rows = await sources.searchAll('Faded', { limit: 5 });
    assert.equal(rows.length, 3); // the two identical catalog copies collapse into one
    assert.equal(rows[0].source, 'deezer'); // exact name + higher source weight wins
    assert.ok(rows.some((r) => r.source === 'youtube'));
  } finally {
    sources.deezer.search = saved.deezer;
    sources.itunes.search = saved.itunes;
    sources.soundcloud.search = saved.soundcloud;
    youtubeSearch.searchYouTube = saved.yt;
  }
});

// ─── 8. ID3 tags ───────────────────────────────────────────────────────────

test('tagMp3 writes album, lyrics and cover art alongside title/artist', async () => {
  const input = path.join(TMP, 'plain.mp3');
  const output = path.join(TMP, 'tagged.mp3');
  fs.writeFileSync(input, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(512, 7)]));
  const cover = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
  const tagged = await mediaTransfer.tagMp3(input, output, {
    title: 'Song', artist: 'Artist', album: 'Album', lyrics: 'la la la', cover,
  });
  assert.ok(tagged);
  assert.deepEqual(mediaTransfer.readId3(tagged), { title: 'Song', artist: 'Artist', album: 'Album' });
  const bytes = fs.readFileSync(tagged);
  assert.match(bytes.toString('latin1'), /USLT/);
  assert.match(bytes.toString('latin1'), /APIC/);
  // USLT is UTF-16LE (ID3v2.3 encoding 0x01), so check the decoded frame.
  const at = bytes.indexOf(Buffer.from('USLT', 'ascii'));
  const size = bytes.readUInt32BE(at + 4);
  const body = bytes.subarray(at + 10, at + 10 + size);
  assert.equal(body[0], 0x01);
  assert.equal(body.toString('ascii', 1, 4), 'eng');
  assert.ok(body.includes(Buffer.from('la la la', 'utf16le')));
});

// ─── 9. Command wiring ─────────────────────────────────────────────────────

test('.song passes its raw YouTube input to the XJX command resolver', async () => {
  const xjxMedia = bot('../lib/downloads/xjx');
  const saved = xjxMedia.downloadSongCommand;
  let received = null;
  try {
    xjxMedia.downloadSongCommand = async (_sock, _msg, _extra, input) => { received = input; return { sent: true }; };
    const song = bot('../commands/song/index');
    const url = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
    await song.execute(socket(), message(), [url], extra());
    assert.equal(received, url);
  } finally { xjxMedia.downloadSongCommand = saved; }
});

test('.video passes its input to XJX without a quality override', async () => {
  const xjxMedia = bot('../lib/downloads/xjx');
  const saved = xjxMedia.downloadVideoCommand;
  let received = null;
  try {
    xjxMedia.downloadVideoCommand = async (_sock, _msg, _extra, input) => { received = input; return { sent: true }; };
    const video = bot('../commands/video/index');
    const url = 'https://www.youtube.com/watch?v=ccccccccccc';
    await video.execute(socket(), message(), [url], extra());
    assert.equal(received, url);
    assert.equal(video.name, 'video');
    assert.equal(video.aliases.includes('ytv'), false);
  } finally { xjxMedia.downloadVideoCommand = saved; }
});

test('.song uses XJX resolution and never the local pipeline', async () => {
  const xjxMedia = bot('../lib/downloads/xjx');
  const saved = { xjxSong: xjxMedia.downloadSongCommand, pipelineSend: mediaPipeline.downloadAndSend };
  const songInputs = [];
  try {
    xjxMedia.downloadSongCommand = async (_s, _m, _e, input) => { songInputs.push(input); return { sent: true }; };
    mediaPipeline.downloadAndSend = async () => { throw new Error('the XJX song path must not use the local pipeline'); };
    const sock = socket();
    sock.sendMessage = async () => ({ key: { id: 'x' } });
    await bot('../commands/song/index').execute(sock, message(), ['Example', 'Song'], { ...extra(), status: async () => ({ update: async () => {} }) });
    assert.deepEqual(songInputs, ['Example Song']);
  } finally {
    xjxMedia.downloadSongCommand = saved.xjxSong;
    mediaPipeline.downloadAndSend = saved.pipelineSend;
  }
});

test('.mfind parses --video/--first/quality and delegates', async () => {
  const saved = { run: deliver.deliverMusic };
  try {
    let seen = null;
    deliver.deliverMusic = async (_s, _m, _e, opts) => { seen = opts; return { sent: true }; };
    const mfind = bot('../commands/mfind/index');
    await mfind.execute(socket(), message(), ['--video', 'Example', 'Song', '--first', '720'], extra());
    assert.equal(seen.kind, 'video');
    assert.equal(seen.height, 720);
    assert.equal(seen.firstHit, true);
    assert.equal(seen.input, 'Example Song');
    const sock = socket();
    await mfind.execute(sock, message(), ['--quality=bad', 'Song'], extra());
    assert.match(sock.sent.at(-1).text, /Quality must be/);
  } finally { deliver.deliverMusic = saved.run; }
});

test('collections open the scoped picker instead of downloading everything', async () => {
  const saved = { resolve: sources.resolveUrl, prompt: selections.sendTextPrompt };
  try {
    sources.resolveUrl = async () => ({ type: 'collection', collection: {
      source: 'deezer', kind: 'album', name: 'Album', owner: 'Artist', cover: '',
      tracks: [
        { title: 'One', artists: ['Artist'], durationMs: 100000 },
        { title: 'Two', artists: ['Artist'], durationMs: 120000 },
      ],
    } });
    let prompt = null;
    selections.sendTextPrompt = async (_s, _m, _e, spec) => { prompt = spec; return { offerId: 'x' }; };
    await deliver.deliverMusic(socket(), message(), extra(), { input: 'https://www.deezer.com/album/1', kind: 'audio' });
    assert.ok(prompt);
    assert.equal(prompt.items.length, 2);
    assert.equal(prompt.label, 'music');
    assert.match(prompt.text, /\*1\.\* One/);
  } finally {
    sources.resolveUrl = saved.resolve;
    selections.sendTextPrompt = saved.prompt;
  }
});

// ─── 10. Repository guards ─────────────────────────────────────────────────

test('no credentials are added to config and retired commands stay retired', () => {
  process.env.DEEZER_ARL = 'syntheticLegacyCredential12345';
  assert.equal(Object.hasOwn(config, 'deezer'), false);
  assert.equal(C.DEEZER_ARL, undefined);
  assert.equal(C.ARL, undefined);
  assert.equal(C.SPOTIFY_TOKEN_URLS.every((u) => u.startsWith('https://')), true);
  assert.equal(Object.keys(C).some((k) => /^(?:arl|api_?key|client_secret|password|bearer_token|media_user_token)$/i.test(k)), false);
  const commands = loadCommands();
  assert.equal(commands.has('mfind'), true);
  for (const name of ['deezer', 'dz', 'audius', 'bilibili']) assert.equal(commands.has(name), false);
  delete process.env.DEEZER_ARL;
});
