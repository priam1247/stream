#!/usr/bin/env node
'use strict';

/**
 * Offline tests for the public embed/player URL registry and its wiring.
 *
 * Adapted from spences10/sveltekit-embed (MIT). No network, no WhatsApp
 * connection: catalog resolvers and delivery helpers are stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-sources-'));
const BOT = createBotFixture(TMP);
const bot = createRequire(path.join(BOT, 'scripts', 'test-embed-sources.js'));
process.chdir(TMP);

const embeds = bot('../utils/musicSources/embeds');
const sources = bot('../utils/musicSources/index');
const model = bot('../utils/musicSources/model');
const spotify = bot('../utils/musicSources/spotifyEmbed');
const deezer = bot('../utils/musicSources/deezer');
const soundcloud = bot('../utils/musicSources/soundcloud');
const deliver = bot('../utils/musicSources/deliver');
const mediaPipeline = bot('../utils/mediaPipeline');
const spotifyUtil = bot('../utils/spotify');
const { loadCommands } = bot('../utils/commandLoader');
const embedCmd = bot('../commands/media/embed');
const dlCmd = bot('../commands/media/dl');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const socket = () => ({
  sent: [],
  async sendMessage(_chat, content) {
    this.sent.push(content);
    return { key: { id: `msg-${this.sent.length}` } };
  },
});
const message = () => ({ key: { remoteJid: 'test@s.whatsapp.net', id: 'm1' }, message: {} });
const extra = () => ({ from: 'test@s.whatsapp.net', isOwner: true });
const sentText = (sock) => sock.sent.map((m) => m.text || '').join('\n');

// ─── 1. Registry ────────────────────────────────────────────────────────────

test('registry covers all 21 sveltekit-embed providers plus a generic fallback', () => {
  const providers = embeds.supportedProviders();
  assert.equal(providers.length, 21);
  const keys = providers.map((p) => p.key);
  for (const key of ['spotify', 'deezer', 'soundcloud', 'soundcloud-player', 'youtube',
    'vimeo', 'tiktok', 'anchor', 'buzzsprout', 'simplecast', 'zencastr', 'bluesky',
    'threads', 'toot', 'tweet', 'codepen', 'gist', 'stackblitz', 'slides', 'relive', 'guild']) {
    assert.ok(keys.includes(key), `missing provider: ${key}`);
  }
  assert.equal(embeds.parseLink('https://example.com/anything').provider, 'generic');
  assert.equal(embeds.parseLink('just a title'), null);
});

test('every provider parses its own embed URL into canonical + embed forms', () => {
  const samples = [
    'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT',
    'https://widget.deezer.com/widget/auto/album/302127',
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb&visual=true',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/?videoseries&list=PLlrxD0HtieHhS8VzuMCfQD4uJ9yne1mE6',
    'https://player.vimeo.com/video/246846978',
    'https://www.tiktok.com/player/v1/6718335390845095173',
    'https://anchor.fm/purrfect-dev/embed/episodes/example-e1vbg9m',
    'https://www.buzzsprout.com/190346/9866589-episode?client_source=admin&iframe=true',
    'https://player.simplecast.com/1c254f66-5d75-48ef-b960-4cfec94baa0b',
    'https://zencastr.com/embed/TARGseQu',
    'https://embed.bsky.app/embed/did:plc:nlvjelw3dy3pddq7qoglleko/app.bsky.feed.post/3l6ud34tnwn2k',
    'https://www.threads.com/t/DePOFVxEe_o/embed/1',
    'https://mas.to/@spences10/109252587760962553/embed',
    'https://twitter.com/adamwathan/status/959078631434731521',
    'https://codepen.io/team/codepen/embed/WNMvXpa',
    'https://gist.github.com/Ennoriel/8c89dc3615292f0a40b04f4f876afd77.pibb',
    'https://stackblitz.com/edit/vitejs-vite-yyoood?embed=1',
    'https://slides.com/spences10/building-with-sveltekit-and-graphql/embed',
    'https://www.relive.cc/view/vAOZokmYVo6/widget',
    'https://guild.host/embeds/guild/svelte-society-london/events/latest',
  ];
  for (const url of samples) {
    const info = embeds.parseLink(url);
    assert.ok(info, `no provider for ${url}`);
    assert.notEqual(info.provider, 'generic', `${url} fell through to generic`);
    // Tweet embeds are blockquotes rendered by widgets.js, not iframe URLs,
    // so their shared link is not a distinct embed URL.
    if (info.provider !== 'tweet') assert.equal(info.isEmbed, true, `${url} not flagged as embed`);
    assert.match(info.canonical, /^https:\/\//);
    assert.match(info.embed, /^https:\/\//);
    assert.equal(info.iframe.loading, 'lazy');
    assert.ok(info.iframe.allow);
    assert.ok(info.iframe.height);
  }
});

// ─── 2. Music catalog embeds ────────────────────────────────────────────────

test('a Spotify embed link normalises to a shared track link', () => {
  const url = 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT';
  const info = embeds.parseLink(url);
  assert.equal(info.provider, 'spotify');
  assert.equal(info.kind, 'track');
  assert.equal(info.canonical, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(info.embed, url);
  assert.equal(info.downloadable, false); // catalog page, needs metadata first
  assert.equal(sources.canonicalize(url), info.canonical);
  assert.equal(sources.isMusicLink(url), true);
  assert.equal(spotifyUtil.parseSpotifyUrl(url)?.id, '4cOdK2wGLETKBW3PvgPWqT');
  assert.equal(spotify.parseUrl(url)?.kind, 'track');
});

test('a Deezer widget link normalises to a shared album link', () => {
  const url = 'https://widget.deezer.com/widget/dark/album/302127';
  const info = embeds.parseLink(url);
  assert.equal(info.provider, 'deezer');
  assert.equal(info.canonical, 'https://www.deezer.com/album/302127');
  assert.equal(info.downloadable, false);
  assert.equal(deezer.parseUrl(url)?.id, '302127');
  assert.equal(sources.isMusicLink(url), true);
  assert.equal(deezer.parseUrl('https://widget.deezer.com/widget/auto/show/496882')?.kind, 'show');
});

test('a SoundCloud player link decodes its ?url= parameter', () => {
  const url = 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fdimension_uk%2Fsets%2Fprospa&visual=false';
  const info = embeds.parseLink(url);
  assert.equal(info.provider, 'soundcloud-player');
  assert.equal(info.kind, 'playlist');
  assert.equal(info.canonical, 'https://soundcloud.com/dimension_uk/sets/prospa');
  assert.equal(sources.normalizeDirectUrl(url), info.canonical);
  assert.equal(soundcloud.parseUrl(info.canonical), info.canonical);
});

test('resolveUrl resolves metadata against the canonical form of an embed link', async () => {
  const saved = { spotify: spotify.resolve, deezer: deezer.resolve };
  try {
    spotify.resolve = async (url) => ({ source: 'spotify', kind: 'track', name: 'x', tracks: [], url });
    deezer.resolve = async (url) => ({ source: 'deezer', kind: 'album', name: 'x', tracks: [], url });
    const spotifyResult = await sources.resolveUrl('https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3');
    assert.equal(spotifyResult.type, 'collection');
    assert.equal(spotifyResult.collection.url, 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
    const deezerResult = await sources.resolveUrl('https://widget.deezer.com/widget/auto/playlist/1479458365');
    assert.equal(deezerResult.collection.url, 'https://www.deezer.com/playlist/1479458365');
  } finally {
    spotify.resolve = saved.spotify;
    deezer.resolve = saved.deezer;
  }
});

// ─── 3. Direct media embeds ─────────────────────────────────────────────────

test('YouTube no-cookie embeds (video and playlist) become downloadable links', () => {
  assert.equal(
    sources.normalizeDirectUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  assert.equal(
    sources.normalizeDirectUrl('https://www.youtube-nocookie.com/embed/?videoseries&list=PLlrxD0HtieHhS8VzuMCfQD4uJ9yne1mE6'),
    'https://www.youtube.com/playlist?list=PLlrxD0HtieHhS8VzuMCfQD4uJ9yne1mE6',
  );
});

test('Vimeo, TikTok, social and code embeds normalise to shared links', () => {
  assert.equal(embeds.toCanonical('https://player.vimeo.com/video/246846978'), 'https://vimeo.com/246846978');
  assert.equal(embeds.toCanonical('https://www.threads.com/t/DePOFVxEe_o/embed/1'), 'https://www.threads.com/t/DePOFVxEe_o');
  assert.equal(embeds.toCanonical('https://mas.to/@spences10/109252587760962553/embed'), 'https://mas.to/@spences10/109252587760962553');
  assert.equal(embeds.toCanonical('https://gist.github.com/Ennoriel/8c89dc3615292f0a40b04f4f876afd77.pibb'), 'https://gist.github.com/Ennoriel/8c89dc3615292f0a40b04f4f876afd77');
  assert.equal(embeds.toEmbed('https://slides.com/spences10/building-with-sveltekit-and-graphql'), 'https://slides.com/spences10/building-with-sveltekit-and-graphql/embed');
  assert.equal(embeds.toCanonical('https://example.com/foo'), null);
});

// ─── 4. Fuzzy relevance (ported docs search) ───────────────────────────────

test('fuzzy scoring requires every term and tolerates abbreviations', () => {
  const item = { title: 'youtube', keywords: ['video'], detail: 'embed' };
  assert.equal(model.fuzzyScore('youtube', item), 120);
  assert.equal(model.fuzzyScore('yout', item), 100);
  assert.equal(model.fuzzyScore('ytb', item), 10);
  assert.equal(model.fuzzyScore('youtube nope', item), 0);
  assert.equal(model.isSubsequence('ytb', 'youtube'), true);
  assert.equal(model.isSubsequence('zyb', 'youtube'), false);
});

// ─── 5. Commands ────────────────────────────────────────────────────────────

test('.embed reports both URL forms and lists providers', async () => {
  const sock = socket();
  await embedCmd.execute(sock, message(), ['https://open.spotify.com/embed/track/abc123'], extra());
  const text = sentText(sock);
  assert.match(text, /Spotify/);
  assert.match(text, /https:\/\/open\.spotify\.com\/track\/abc123/);
  assert.match(text, /https:\/\/open\.spotify\.com\/embed\/track\/abc123/);
  assert.match(text, /loading=lazy/);

  const listSock = socket();
  await embedCmd.execute(listSock, message(), ['--list'], extra());
  assert.match(sentText(listSock), /Recognised embed providers/);
  assert.match(sentText(listSock), /Deezer/);
});

test('.embed --audio delegates with the canonical link', async () => {
  const saved = deliver.deliverMusic;
  const calls = [];
  try {
    deliver.deliverMusic = async (...args) => { calls.push(args[3]); return { ok: true }; };
    await embedCmd.execute(socket(), message(), [
      '--audio', 'https://widget.deezer.com/widget/auto/track/3135556',
    ], extra());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'https://www.deezer.com/track/3135556');
    assert.equal(calls[0].kind, 'audio');
  } finally {
    deliver.deliverMusic = saved;
  }
});

test('.dl normalises an embed URL before the generic yt-dlp path', async () => {
  const saved = { send: mediaPipeline.downloadAndSend, deliver: deliver.deliverMusic };
  const calls = [];
  try {
    mediaPipeline.downloadAndSend = async (_sock, _msg, _extra, opts) => { calls.push(opts); return { ok: true }; };
    deliver.deliverMusic = async () => { throw new Error('should not route to music sources'); };
    await dlCmd.execute(socket(), message(), ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'], extra());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  } finally {
    mediaPipeline.downloadAndSend = saved.send;
    deliver.deliverMusic = saved.deliver;
  }
});

test('command loader registers .embed and its aliases', () => {
  const commands = loadCommands();
  assert.equal(commands.get('embed')?.name, 'embed');
  assert.equal(commands.get('linkinfo')?.name, 'embed');
  assert.equal(commands.get('unembed')?.name, 'embed');
});

test('no credentials were added for the embed registry', () => {
  const C = bot('../utils/musicSources/constants');
  assert.equal(C.EMBED_IFRAME_DEFAULTS.loading, 'lazy');
  assert.equal(typeof C.EMBED_LOAD_GIVE_UP_MS, 'number');
  assert.equal(Object.keys(C).some((k) => /^(?:arl|api_?key|client_secret|password|bearer_token|media_user_token)$/i.test(k)), false);
});
