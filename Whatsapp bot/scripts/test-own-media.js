'use strict';

/**
 * Offline tests for the standalone utils/ownMedia/ engine.
 *
 * Everything is driven through the transport / downloader test hooks, so no
 * YouTube, SoundCloud or ffmpeg connection is needed. These tests are part of
 * `npm run test:media`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const bot = (p) => require(path.join(ROOT, p));

const C = bot('utils/ownMedia/constants');
const http = bot('utils/ownMedia/http');
const clients = bot('utils/ownMedia/clients');
const formats = bot('utils/ownMedia/formats');
const soundcloud = bot('utils/ownMedia/soundcloud');
const convert = bot('utils/ownMedia/convert');
const engine = bot('utils/ownMedia/engine');
const mediaTransfer = bot('utils/mediaTransfer');
const mediaPipeline = bot('utils/mediaPipeline');

/** Reset the two global transport hooks after every test. */
const resetHooks = () => {
  http.setTransportForTests(null);
  http.setDownloadForTests(null);
  soundcloud._resetForTests();
};

/** A transport stub: responder(url, opts) → { status, body } | string. */
const withTransport = (responder) => http.setTransportForTests(async (url, opts) => {
  const result = await responder(String(url), opts);
  return result == null ? { status: 200, body: '' } : result;
});

const playerResponse = (overrides = {}) => ({
  playabilityStatus: { status: 'OK', reason: '' },
  videoDetails: {
    title: 'Namadingo - Tuli (Official Audio)',
    author: 'Namadingo',
    lengthSeconds: '214',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/x.jpg' }] },
  },
  streamingData: {
    formats: [{
      itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      bitrate: 500000, width: 640, height: 360, qualityLabel: '360p',
      url: 'https://rr1---sn-x.googlevideo.com/videoplayback?sig=abc',
    }],
    adaptiveFormats: [
      {
        itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128000, audioQuality: 'AUDIO_QUALITY_MEDIUM',
        url: 'https://rr1---sn-x.googlevideo.com/videoplayback?audio=1',
      },
      {
        itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"',
        bitrate: 1500000, width: 1920, height: 1080, qualityLabel: '1080p',
        url: 'https://rr1---sn-x.googlevideo.com/videoplayback?video=1',
      },
      {
        itag: 22, mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
        signatureCipher: 's=cipher&url=https%3A%2F%2Fevil.example.com%2Fx',
      },
    ],
  },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────

test('brick 1: constants expose no secrets and pin an allowlist', () => {
  assert.match(C.YT_PLAYER, /^https:\/\/www\.youtube\.com\//);
  assert.equal(C.PO_TOKEN, String(process.env.YT_PO_TOKEN || '').trim());
  assert.equal(C.VISITOR_DATA, String(process.env.YT_VISITOR_DATA || '').trim());
  assert.ok(C.CLIENTS.length >= 6);
  assert.ok(C.CLIENTS.some((c) => c.embedded));
  assert.ok(C.STREAM_HOSTS.includes('googlevideo.com'));
  assert.ok(C.STREAM_HOSTS.includes('sndcdn.com'));
  const raw = fs.readFileSync(path.join(ROOT, 'utils/ownMedia/constants.js'), 'utf8');
  assert.ok(!/(BEGIN (RSA |EC )?PRIVATE KEY|widevine|device_private_key)/i.test(raw));
});

test('brick 2: assertSafe blocks http, credentials and unlisted hosts', () => {
  assert.equal(http.assertSafe('https://www.youtube.com/youtubei/v1/player?key=x').hostname, 'www.youtube.com');
  assert.equal(http.assertSafe('https://rr1---sn-x.googlevideo.com/videoplayback').hostname, 'rr1---sn-x.googlevideo.com');
  assert.equal(http.assertSafe('https://cf-media.sndcdn.com/track.mp3').hostname, 'cf-media.sndcdn.com');
  assert.throws(() => http.assertSafe('http://www.youtube.com/'), (e) => e.code === 'UNSAFE_URL');
  assert.throws(() => http.assertSafe('https://user:pass@www.youtube.com/'), (e) => e.code === 'UNSAFE_URL');
  assert.throws(() => http.assertSafe('https://169.254.169.254/latest/meta-data'), (e) => e.code === 'UNSAFE_URL');
  assert.throws(() => http.assertSafe('not a url'), (e) => e.code === 'BAD_URL');
});

test('brick 2: request/getJson/postJson/getText use the injected transport', async () => {
  try {
    withTransport(async (url, opts) => {
      if (url.includes('/player')) return { status: 200, body: JSON.stringify({ ok: true, method: opts.method }) };
      if (url.includes('/api')) return { status: 200, body: '{"value":42}' };
      if (url.includes('/page')) return { status: 200, body: 'hello world' };
      return { status: 404, body: 'nope' };
    });
    const raw = await http.request('GET', 'https://www.youtube.com/page', { headers: { Accept: 'text/html' } });
    assert.equal(raw.status, 200);
    assert.equal(await http.getText('https://www.youtube.com/page'), 'hello world');
    assert.deepEqual(await http.getJson('https://www.youtube.com/api'), { value: 42 });
    assert.deepEqual(await http.postJson('https://www.youtube.com/player', { videoId: 'x' }), { ok: true, method: 'POST' });
    await assert.rejects(() => http.getText('https://www.youtube.com/missing'), (e) => e.code === 'HTTP_404');
  } finally { resetHooks(); }
});

test('brick 2: streamTo delegates to the downloader hook and reports bytes', async () => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-http-'));
    const dest = path.join(dir, 'a.bin');
    http.setDownloadForTests(async (url, file) => {
      fs.writeFileSync(file, Buffer.alloc(2048, 3));
      return { file, bytes: 2048, contentType: 'audio/mpeg' };
    });
    const out = await http.streamTo('https://rr1---sn-x.googlevideo.com/videoplayback', dest, { maxBytes: 4096 });
    assert.equal(out.bytes, 2048);
    assert.equal(fs.statSync(dest).size, 2048);
    await assert.rejects(
      () => http.streamTo('https://evil.example.com/x', dest),
      (e) => e.code === 'UNSAFE_URL',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { resetHooks(); }
});

test('brick 3: videoIdOf handles watch, shorts, embed, nocookie and youtu.be', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
  ]) assert.equal(clients.videoIdOf(url), id, url);
  for (const url of ['https://example.com/watch?v=dQw4w9WgXcQ', 'not a url', 'https://youtube.com/']) {
    assert.equal(clients.videoIdOf(url), null, url);
  }
  assert.equal(engine.isSoundCloudUrl('https://soundcloud.com/artist/track'), true);
  assert.equal(engine.isYouTubeUrl('https://soundcloud.com/artist/track'), false);
});

test('brick 3: normalizeFormat marks ciphered streams as not downloadable', () => {
  const plain = clients.normalizeFormat({ itag: 140, mimeType: 'audio/mp4', bitrate: 128000, url: 'https://x.googlevideo.com/a' });
  assert.equal(plain.downloadable, true);
  assert.equal(plain.hasAudio, true);
  assert.equal(plain.hasVideo, false);
  const ciphered = clients.normalizeFormat({
    itag: 22, mimeType: 'video/mp4', signatureCipher: 's=abc&url=https%3A%2F%2Fx.googlevideo.com%2Fv',
  });
  assert.equal(ciphered.ciphered, true);
  assert.equal(ciphered.downloadable, false);
  const progressive = clients.normalizeFormat({ itag: 18, mimeType: 'video/mp4', url: 'https://x.googlevideo.com/v' });
  assert.equal(progressive.hasAudio, true);
  assert.equal(progressive.hasVideo, true);
});

test('brick 3: embedded client bodies carry thirdParty and client headers', () => {
  const embedded = C.CLIENTS.find((c) => c.embedded);
  const body = clients.bodyFor(embedded, { videoId: 'dQw4w9WgXcQ' });
  assert.equal(body.context.thirdParty.embedUrl, 'https://www.youtube.com/');
  assert.equal(body.videoId, 'dQw4w9WgXcQ');
  assert.equal(body.contentCheckOk, true);
  assert.equal(clients.headersFor(embedded)['X-YouTube-Client-Name'], String(embedded.nameId));
});

test('brick 3: player rotates past a login-required client', async () => {
  try {
    let calls = 0;
    withTransport(async (_url, opts) => {
      calls += 1;
      const name = opts.body?.context?.client?.clientName;
      if (name === 'TVHTML5_SIMPLY_EMBEDDED_PLAYER') {
        return { status: 200, body: JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Video is login required' } }) };
      }
      return { status: 200, body: JSON.stringify(playerResponse()) };
    });
    const { result, attempts } = await clients.player('dQw4w9WgXcQ');
    assert.equal(calls, 2);
    assert.equal(attempts[0].ok, false);
    assert.equal(attempts[0].status, 'LOGIN_REQUIRED');
    assert.equal(result.client, 'WEB_EMBEDDED');
    assert.equal(result.title, 'Namadingo - Tuli (Official Audio)');
    assert.equal(result.formats.length, 4);
    assert.equal(result.formats.filter((f) => f.downloadable).length, 3);
  } finally { resetHooks(); }
});

test('brick 3: player reports a useful error after every client fails', async () => {
  try {
    withTransport(async () => ({ status: 200, body: JSON.stringify({
      playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Video is login required' },
    }) }));
    await assert.rejects(
      () => clients.player('dQw4w9WgXcQ', { clients: C.CLIENTS.slice(0, 2) }),
      (e) => e.code === 'NO_FORMATS' && /TV_EMBEDDED/.test(e.message) && e.attempts.length === 2,
    );
  } finally { resetHooks(); }
});

test('brick 3: public search parses videoRenderer and lockupViewModel rows', async () => {
  try {
    withTransport(async () => ({ status: 200, body: JSON.stringify({
      contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
        { itemSectionRenderer: { contents: [
          { videoRenderer: {
            videoId: 'aaaaaaaaaaa',
            title: { runs: [{ text: 'Namadingo ' }, { text: 'Tuli' }] },
            ownerText: { runs: [{ text: 'Namadingo' }] },
            lengthText: { simpleText: '3:34' },
            thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/1.jpg' }] },
          } },
          { lockupViewModel: {
            contentId: 'bbbbbbbbbbb',
            metadata: { lockupMetadataViewModel: { title: { content: 'Tuli live' } } },
          } },
        ] } },
      ] } } } },
    }) }));
    const rows = await clients.search('namadingo tuli');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, 'Namadingo Tuli');
    assert.equal(rows[0].duration, 214);
    assert.equal(rows[0].url, `${C.YT_WATCH}aaaaaaaaaaa`);
    assert.equal(rows[1].title, 'Tuli live');
  } finally { resetHooks(); }
});

test('brick 4: SoundCloud scrapes a client id, resolves and follows transcodings', async () => {
  try {
    const ID = '0123456789abcdef0123456789abcdef';
    withTransport(async (url) => {
      if (url === 'https://soundcloud.com/') {
        return { status: 200, body: '<html><script src="https://a-v2.sndcdn.com/assets/app.js"></script></html>' };
      }
      if (url.includes('/assets/app.js')) {
        return { status: 200, body: `window.x={client_id:"${ID}"};` };
      }
      if (url.includes('/resolve')) {
        return { status: 200, body: JSON.stringify({
          id: 123, title: 'Tuli', duration: 214000, artwork_url: 'https://i1.sndcdn.com/a-large.jpg',
          user: { username: 'Namadingo' },
          media: { transcodings: [
            { url: 'https://api-v2.soundcloud.com/media/123/stream/hls', format: { protocol: 'hls', mime_type: 'audio/mpeg' } },
            { url: 'https://api-v2.soundcloud.com/media/123/stream/progressive', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
          ] },
        }) };
      }
      if (url.includes('/stream/progressive')) {
        return { status: 200, body: JSON.stringify({ url: 'https://cf-media.sndcdn.com/track.mp3?Policy=x' }) };
      }
      if (url.includes('/search/tracks')) {
        return { status: 200, body: JSON.stringify({ collection: [
          { id: 123, title: 'Tuli', duration: 214000, permalink_url: 'https://soundcloud.com/n/tuli',
            user: { username: 'Namadingo' }, artwork_url: 'https://i1.sndcdn.com/a-large.jpg',
            media: { transcodings: [{ url: 'https://api-v2.soundcloud.com/media/123/stream/progressive', format: { protocol: 'progressive' } }] } },
        ] }) };
      }
      return { status: 404, body: '' };
    });

    assert.equal(await soundcloud.getClientId(), ID);
    const resolved = await soundcloud.resolve('https://soundcloud.com/n/tuli');
    assert.equal(resolved.title, 'Tuli');
    const stream = await soundcloud.streamUrl(resolved);
    assert.equal(stream.protocol, 'progressive');
    assert.match(stream.url, /cf-media\.sndcdn\.com/);
    const rows = await soundcloud.search('namadingo tuli');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].durationMs, 214000);
    assert.match(rows[0].cover, /t500x500/);
    assert.equal(soundcloud.pickByDuration(rows, 214000)?.title, 'Tuli');
    assert.equal(soundcloud.pickByDuration(rows, 900000)?.title, 'Tuli');
  } finally { resetHooks(); }
});

test('brick 4: w.soundcloud.com player URL recovers the real track URL', () => {
  const canonical = engine.canonicalSoundCloud(
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fn%2Ftuli',
  );
  assert.equal(canonical, 'https://soundcloud.com/n/tuli');
});

const fakeResult = () => ({
  client: 'WEB_EMBEDDED',
  title: 'Tuli', author: 'Namadingo', duration: 214, thumbnail: '',
  hlsManifestUrl: '', dashManifestUrl: '',
  formats: [
    { itag: 140, mime: 'audio/mp4', bitrate: 128000, width: 0, height: 0, hasVideo: false, hasAudio: true, url: 'https://x.googlevideo.com/a', downloadable: true },
    { itag: 18, mime: 'video/mp4', bitrate: 500000, width: 640, height: 360, hasVideo: true, hasAudio: true, url: 'https://x.googlevideo.com/p', downloadable: true },
    { itag: 137, mime: 'video/mp4', bitrate: 2000000, width: 1920, height: 1080, hasVideo: true, hasAudio: false, url: 'https://x.googlevideo.com/v', downloadable: true },
  ],
});

test('brick 4/5: format selection prefers audio-only, progressive mp4, then mux', () => {
  const result = fakeResult();
  const audio = formats.chooseAudio(result);
  assert.equal(audio.mode, 'direct');
  assert.equal(audio.itag, 140);
  assert.equal(audio.needsAudioExtract, false);

  const video = formats.chooseVideo(result, 720);
  assert.equal(video.mode, 'direct');
  assert.equal(video.itag, 18);

  const mux = formats.chooseVideo({ ...result, formats: result.formats.filter((f) => f.itag !== 18) }, 1080);
  assert.equal(mux.mode, 'ffmpeg-mux');
  assert.equal(mux.url, 'https://x.googlevideo.com/v');
  assert.equal(mux.audioUrl, 'https://x.googlevideo.com/a');

  const hls = formats.chooseAudio({ formats: [], hlsManifestUrl: 'https://x.googlevideo.com/master.m3u8' });
  assert.equal(hls.mode, 'ffmpeg-hls');
  assert.equal(formats.chooseAudio({ formats: [] }), null);
});

test('brick 7: buildPlan falls back to SoundCloud search when the player fails', async () => {
  const saved = { player: clients.player, search: clients.search, scSearch: soundcloud.search, scStream: soundcloud.streamUrl };
  try {
    clients.player = async () => { throw Object.assign(new Error('login required'), { code: 'NO_FORMATS' }); };
    clients.search = async () => [];
    soundcloud.search = async () => [{ title: 'Tuli', author: 'Namadingo', durationMs: 214000, cover: '', track: { id: 1 } }];
    soundcloud.streamUrl = async () => ({ url: 'https://cf-media.sndcdn.com/track.mp3', protocol: 'progressive', mime: 'audio/mpeg' });
    const attempts = [];
    const plan = await engine.buildPlan({
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      track: { title: 'Tuli', artists: ['Namadingo'], durationMs: 214000 },
      kind: 'audio', attempts,
    });
    assert.equal(plan.source, 'soundcloud-search');
    assert.equal(plan.mode, 'direct');
    assert.match(plan.url, /sndcdn\.com/);
    assert.ok(attempts.some((a) => a.brick === 'YouTube player'));
  } finally {
    clients.player = saved.player; clients.search = saved.search;
    soundcloud.search = saved.scSearch; soundcloud.streamUrl = saved.scStream;
  }
});

test('brick 7: buildPlan falls back to YouTube search + player', async () => {
  const saved = { player: clients.player, search: clients.search, scSearch: soundcloud.search };
  try {
    let n = 0;
    clients.player = async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('no formats'), { code: 'NO_FORMATS' });
      return { result: fakeResult(), attempts: [] };
    };
    clients.search = async () => [{ id: 'ccccccccccc', title: 'Tuli', author: 'Namadingo', duration: 214, url: '', thumbnail: '' }];
    soundcloud.search = async () => { throw new Error('SoundCloud offline'); };
    const plan = await engine.buildPlan({
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      track: { title: 'Tuli', artists: ['Namadingo'], durationMs: 214000 },
      kind: 'audio', attempts: [],
    });
    assert.equal(plan.source, 'youtube-search');
    assert.equal(plan.url, 'https://x.googlevideo.com/a');
    assert.equal(plan.mime, 'audio/mp4');
  } finally {
    clients.player = saved.player; clients.search = saved.search; soundcloud.search = saved.scSearch;
  }
});

test('brick 7: shouldHandle claims music links but not images or other sites', () => {
  assert.equal(engine.shouldHandle('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'audio'), true);
  assert.equal(engine.shouldHandle('https://soundcloud.com/a/b', 'video'), true);
  assert.equal(engine.shouldHandle('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'image'), false);
  assert.equal(engine.shouldHandle('https://www.tiktok.com/@a/video/1', 'video'), false);
  assert.equal(engine.shouldHandle('', 'audio', { title: 'Tuli' }), true);
  assert.equal(engine.shouldHandle('', 'audio'), false);
});

test('brick 7: deliverMedia downloads, converts, sends and cleans up', async () => {
  const saved = {
    player: clients.player, scSearch: soundcloud.search,
    toMp3: convert.toMp3, tagMp3: mediaTransfer.tagMp3,
  };
  try {
    clients.player = async () => ({ result: fakeResult(), attempts: [] });
    soundcloud.search = async () => { throw new Error('not needed'); };
    convert.toMp3 = async (input, output) => { fs.copyFileSync(input, output); return output; };
    mediaTransfer.tagMp3 = async () => null;
    http.setDownloadForTests(async (url, dest) => {
      fs.writeFileSync(dest, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20000, 4)]));
      return { file: dest, bytes: 20003, contentType: 'audio/mpeg' };
    });

    const sent = [];
    const sock = { sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'x' } }; } };
    const msg = { key: { remoteJid: 'c@s.whatsapp.net', id: 'm1' } };
    const filesSeen = [];
    const result = await engine.deliverMedia(sock, msg, { from: 'c@s.whatsapp.net' }, {
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      title: 'Tuli', author: 'Namadingo', kind: 'audio',
      track: { title: 'Tuli', artists: ['Namadingo'], durationMs: 214000 },
    });
    assert.deepEqual({ sent: result.sent, source: result.source }, { sent: true, source: 'youtube' });
    const doc = sent.find((m) => m.document);
    assert.ok(doc, 'no document was sent');
    assert.match(doc.fileName, /Tuli\.mp3$/);
    assert.equal(doc.mimetype, 'audio/mpeg');
    assert.match(doc.caption, /youtube/);
    assert.ok(sent.some((m) => m.react?.text === '✅'));
    filesSeen.push(doc.document.url);
    for (const f of filesSeen) assert.equal(fs.existsSync(f), false, `temp file leaked: ${f}`);
  } finally {
    clients.player = saved.player; soundcloud.search = saved.scSearch;
    convert.toMp3 = saved.toMp3; mediaTransfer.tagMp3 = saved.tagMp3;
    resetHooks();
  }
});

test('brick 7: a failed engine sends a per-brick explanation, not a generic error', async () => {
  const saved = { player: clients.player, search: clients.search, scSearch: soundcloud.search };
  try {
    clients.player = async () => { throw Object.assign(new Error('no formats'), { code: 'NO_FORMATS' }); };
    clients.search = async () => [];
    soundcloud.search = async () => [];
    const sent = [];
    const sock = { sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'x' } }; } };
    const msg = { key: { remoteJid: 'c@s.whatsapp.net', id: 'm2' } };
    const result = await engine.deliverMedia(sock, msg, { from: 'c@s.whatsapp.net' }, {
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Tuli', kind: 'audio',
    });
    assert.equal(result.sent, false);
    assert.equal(result.code, 'NO_SOURCE');
    const text = sent.map((m) => m.text || '').join('\n');
    assert.match(text, /Sources tried/);
    assert.match(text, /mdiag/);
    assert.match(text, /NO_FORMATS|NO_MATCH/);
  } finally {
    clients.player = saved.player; clients.search = saved.search; soundcloud.search = saved.scSearch;
  }
});

test('mediaPipeline delegates YouTube links to the standalone engine', async () => {
  const saved = engine.deliverMedia;
  try {
    let seen = null;
    engine.deliverMedia = async (_s, _m, _e, opts) => { seen = opts; return { sent: true, source: 'youtube' }; };
    const sock = { sendMessage: async () => ({ key: { id: 'x' } }) };
    const msg = { key: { remoteJid: 'c@s.whatsapp.net', id: 'm3' } };
    await mediaPipeline.downloadAndSend(sock, msg, { from: 'c@s.whatsapp.net' }, {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', kind: 'audio', lane: 'light',
      track: { title: 'Tuli', artists: ['Namadingo'] },
    });
    assert.equal(seen?.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(seen?.kind, 'audio');
    assert.equal(seen?.track?.title, 'Tuli');
  } finally { engine.deliverMedia = saved; }
});

test('musicSources.deliverMusic passes track metadata through to the engine', async () => {
  const sources = bot('utils/musicSources/index');
  const deliver = bot('utils/musicSources/deliver');
  const saved = {
    resolve: sources.resolveUrl, find: sources.findUpload,
    lyrics: sources.getLyrics, cover: sources.fetchCover, send: mediaPipeline.downloadAndSend,
  };
  try {
    sources.resolveUrl = async () => ({ type: 'collection', collection: {
      name: 'Song', owner: 'Artist', tracks: [{ title: 'Song', artists: ['Artist'], durationMs: 200000 }],
    } });
    sources.findUpload = async () => ({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', duration: 200 });
    sources.getLyrics = async () => ({ plain: 'words' });
    sources.fetchCover = async () => null;
    let opts = null;
    mediaPipeline.downloadAndSend = async (_s, _m, _e, o) => { opts = o; return { sent: true }; };
    const sock = { sendMessage: async () => ({ key: { id: 'x' } }) };
    const msg = { key: { remoteJid: 'c@s.whatsapp.net', id: 'm4' } };
    await deliver.deliverMusic(sock, msg, { from: 'c@s.whatsapp.net' }, {
      input: 'https://www.deezer.com/track/1', kind: 'audio', firstHit: true,
    });
    assert.equal(opts?.url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
    assert.equal(opts?.track?.title, 'Song');
    assert.equal(opts?.lyrics, 'words');
  } finally {
    sources.resolveUrl = saved.resolve; sources.findUpload = saved.find;
    sources.getLyrics = saved.lyrics; sources.fetchCover = saved.cover;
    mediaPipeline.downloadAndSend = saved.send;
  }
});

test('deliverMusic still sends when no public upload was found (engine searches)', async () => {
  const sources = bot('utils/musicSources/index');
  const deliver = bot('utils/musicSources/deliver');
  const saved = {
    resolve: sources.resolveUrl, find: sources.findUpload,
    lyrics: sources.getLyrics, cover: sources.fetchCover, send: mediaPipeline.downloadAndSend,
  };
  try {
    sources.resolveUrl = async () => ({ type: 'collection', collection: {
      name: 'Song', tracks: [{ title: 'Song', artists: ['Artist'], durationMs: 200000 }],
    } });
    sources.findUpload = async () => null;
    sources.getLyrics = async () => null;
    sources.fetchCover = async () => null;
    let opts = null;
    mediaPipeline.downloadAndSend = async (_s, _m, _e, o) => { opts = o; return { sent: true }; };
    const sock = { sendMessage: async () => ({ key: { id: 'x' } }) };
    const msg = { key: { remoteJid: 'c@s.whatsapp.net', id: 'm5' } };
    await deliver.deliverMusic(sock, msg, { from: 'c@s.whatsapp.net' }, {
      input: 'https://www.deezer.com/track/1', kind: 'audio', firstHit: true,
    });
    assert.equal(opts?.url, '');
    assert.equal(opts?.track?.title, 'Song');
    assert.equal(engine.shouldHandle(opts?.url, 'audio', opts?.track), true);
  } finally {
    sources.resolveUrl = saved.resolve; sources.findUpload = saved.find;
    sources.getLyrics = saved.lyrics; sources.fetchCover = saved.cover;
    mediaPipeline.downloadAndSend = saved.send;
  }
});

test('.mdiag is registered with its aliases', () => {
  const { loadCommands } = bot('utils/commandLoader');
  const commands = loadCommands();
  assert.equal(commands.get('mdiag')?.name, 'mdiag');
  assert.equal(commands.get('mediadiag')?.name, 'mdiag');
  assert.equal(commands.get('ownmedia')?.name, 'mdiag');
});

test('.mdiag runs every brick and reports them in one message', async () => {
  const mdiag = bot('commands/media/mdiag');
  try {
    const ID = '0123456789abcdef0123456789abcdef';
    withTransport(async (url, opts) => {
      if (opts.method === 'POST' && url.includes('/player')) {
        return { status: 200, body: JSON.stringify(playerResponse()) };
      }
      if (opts.method === 'POST' && url.includes('/search')) {
        return { status: 200, body: JSON.stringify({ contents: { twoColumnSearchResultsRenderer: {
          primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
            { videoRenderer: { videoId: 'aaaaaaaaaaa', title: { simpleText: 'Tuli' }, lengthText: { simpleText: '3:34' } } },
          ] } }] } },
        } } }) };
      }
      if (url === 'https://soundcloud.com/') {
        return { status: 200, body: '<script src="https://a-v2.sndcdn.com/assets/app.js"></script>' };
      }
      if (url.includes('/assets/app.js')) return { status: 200, body: `client_id:"${ID}"` };
      if (url.includes('/search/tracks')) {
        return { status: 200, body: JSON.stringify({ collection: [
          { id: 1, title: 'Tuli', duration: 214000, permalink_url: 'https://soundcloud.com/n/tuli', user: { username: 'Namadingo' } },
        ] }) };
      }
      return { status: 200, body: 'ok' };
    });
    const sent = [];
    const sock = { sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'x' } }; } };
    const msg = { key: { remoteJid: 'c@s.whatsapp.net', id: 'm6' } };
    await mdiag.execute(sock, msg, ['namadingo', 'tuli'], { from: 'c@s.whatsapp.net' });
    const text = sent.map((m) => m.text || '').join('\n');
    assert.match(text, /ownMedia diagnostics/);
    assert.match(text, /ffmpeg binary/);
    assert.match(text, /HTTPS transport/);
    assert.match(text, /YouTube player/);
    assert.match(text, /format selection/);
    assert.match(text, /SoundCloud client id/);
    assert.ok((text.match(/✅/g) || []).length >= 5, text);
    assert.match(text, /mfind namadingo tuli/);
  } finally { resetHooks(); }
});
