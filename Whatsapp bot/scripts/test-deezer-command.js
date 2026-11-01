'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deezer-command-'));
const ROOT = createBotFixture(TEMP);
process.chdir(TEMP);
process.env.DEEZER_ARL = 'SYNTHETIC_FAKE_ARL_123456789';
const at = (file) => require(path.join(ROOT, file));
const dz = at('utils/deezer');
const transfer = at('utils/mediaTransfer');
const ffmpeg = at('utils/ffmpeg');
const disk = at('utils/diskSpace');
const queue = at('utils/jobQueue');
const settings = at('utils/mediaSettings');
const selections = at('utils/selections');
const telemetry = at('utils/telemetry');
const YT = at('utils/youtubedl');
const ytSearch = at('utils/youtubeSearch');
const spotify = at('utils/spotify');
const pipeline = at('utils/mediaPipeline');
let deliveries = [];
pipeline.downloadAndSend = async (_sock, _msg, _extra, opts) => { deliveries.push(opts); };
let prompt = null;
let picker = false;
let responseError = null;
let probeResult = { probed: true, hasAudio: true, duration: 200 };
let createdPaths = [];
let searchRows = [
  { id: '1234567', url: 'https://www.deezer.com/track/1234567', title: 'Song', artist: 'Artist', album: 'Album', duration: 200 },
  { id: '7654321', url: 'https://www.deezer.com/track/7654321', title: 'Song (Live)', artist: 'Artist', album: 'Live', duration: 250 },
];
const sourceBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12_000, 3)]);
dz.createClient = () => ({
  async resolveTrackId() { throw Object.assign(new Error('Not a track'), { code: 'DEEZER_TRACK' }); },
  async search() { if (responseError) throw responseError; return searchRows; },
  async download(id, file) {
    if (responseError) throw responseError;
    fs.writeFileSync(file, sourceBytes);
    createdPaths.push(file);
    const found = searchRows.find((r) => r.id === id) || searchRows[0];
    return { ...found, file };
  },
});
transfer.sniffFile = () => ({ kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' });
transfer.probeMedia = async () => probeResult;
transfer.tagMp3 = async (input, output) => { fs.copyFileSync(input, output); return output; };
ffmpeg.works = () => true;
disk.reserveSpace = () => ({ release() {} });
queue.runInLane = async (_lane, run) => run();
settings.get = (key, fallback) => key === 'searchPicker' ? picker : fallback;
selections.sendTextPrompt = async (_sock, _msg, _extra, opts) => { prompt = opts; };
telemetry.recordDownloadSuccess = () => {};
telemetry.recordFailure = () => {};
const cmd = at('commands/media/deezer');
const song = at('commands/media/song');
const spotifyCommand = at('commands/media/spotify');
const menu = at('commands/general/menu');
const message = { key: { remoteJid: 'self@s.whatsapp.net', id: '1' }, message: {} };
const extra = { from: 'self@s.whatsapp.net', isOwner: false, status: async () => ({ update: async () => {} }) };
const sent = [];
const sock = { async sendMessage(_to, body) {
  if (body.document || body.audio) {
    const file = body.document?.url || body.audio?.url;
    assert.ok(fs.existsSync(file), 'temporary file exists through delivery');
    assert.deepEqual(fs.readFileSync(file), sourceBytes);
  }
  sent.push(body);
} };

test.after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
test.beforeEach(() => {
  prompt = null; picker = false; responseError = null; sent.length = 0; deliveries = []; createdPaths = [];
  probeResult = { probed: true, hasAudio: true, duration: 200 };
});

test('explicit Deezer title and track link send private temp files and clean up', async () => {
  await cmd.execute(sock, message, ['Artist', 'Song'], extra);
  const doc = sent.find((x) => x.document);
  assert.equal(doc.fileName, 'Artist - Song.mp3');
  assert.match(doc.caption, /via Deezer/);
  assert.equal(fs.existsSync(doc.document.url), false);
  assert.doesNotMatch(JSON.stringify(sent), /SYNTHETIC_FAKE_ARL/);
  sent.length = 0;
  await cmd.execute(sock, message, ['https://www.deezer.com/en/track/1234567', 'audio'], extra);
  assert.equal(sent.find((x) => x.audio).mimetype, 'audio/mpeg');
});

test('picker preserves chosen track and send mode', async () => {
  picker = true;
  await cmd.execute(sock, message, ['Artist', 'Song', 'audio'], extra);
  assert.equal(prompt.items.length, 2);
  assert.equal(sent.some((x) => x.audio || x.document), false);
  // Use a matching-duration version to exercise the selected item path.
  await prompt.run(sock, message, extra, prompt.items[0]);
  assert.ok(sent.some((x) => x.audio));
});

test('does not expose errors or fall back on explicit Deezer links or delivery errors', async () => {
  responseError = Object.assign(new Error('cookie=SYNTHETIC_FAKE_ARL_123456789'), { code: 'DEEZER_AUTH' });
  assert.equal(await cmd.attempt(sock, message, extra, { input: 'Artist Song', fallback: true }), false);
  assert.equal(sent.length, 0);
  assert.equal(await cmd.attempt(sock, message, extra, { input: 'https://www.deezer.com/track/1234567', fallback: true }), true);
  assert.match(sent.find((s) => s.text).text, /temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(sent), /SYNTHETIC_FAKE_ARL/);
  responseError = null;
  const badSocket = { async sendMessage(_to, body) { if (body.document) throw new Error('untrusted error text'); sent.push(body); } };
  assert.equal(await cmd.attempt(badSocket, message, extra, { input: 'Artist Song', fallback: true }), true);
  assert.match(sent.at(-2).text, /Could not send/);
  assert.ok(createdPaths.every((file) => !fs.existsSync(file)));
});

test('unsupported and look-alike URLs are not sent to a search endpoint', async () => {
  await cmd.execute(sock, message, ['https://deezer.com.evil.test/track/1234567'], extra);
  assert.match(sent[0].text, /Deezer track link/);
  sent.length = 0;
  await cmd.execute(sock, message, ['https://www.deezer.com/album/1234567'], extra);
  assert.match(sent.find((s) => s.text).text, /full Deezer track link/);
});

test('Spotify identity matching rejects covers and materially different lengths', () => {
  const expected = { title: 'Song', artist: 'Artist', duration: 200 };
  assert.equal(dz.sameRecording(searchRows[0], expected), true);
  assert.equal(dz.sameRecording(searchRows[1], expected), false);
  assert.equal(dz.sameRecording({ ...searchRows[0], artist: 'Other' }, expected), false);
  assert.equal(dz.sameRecording({ ...searchRows[0], duration: 300 }, expected), false);
  assert.equal(dz.sameRecording({ ...searchRows[0], duration: 0 }, expected), false);
  assert.equal(dz.sameRecording(searchRows[0], { ...expected, artist: '' }), false);
  assert.equal(dz.sameRecording({ ...searchRows[0], isrc: 'US-ABC-12-34567' }, { ...expected, isrc: 'USABC1234567' }, { requireIsrc: true }), true);
  assert.equal(dz.sameRecording({ ...searchRows[0], isrc: 'OTHER' }, { ...expected, isrc: 'USABC1234567' }), false);
  assert.equal(dz.sameRecording(searchRows[0], { ...expected, isrc: 'USABC1234567' }, { requireIsrc: true }), false);
});

test('song titles prefer Deezer but explicit YouTube links never switch recording', async () => {
  const realAttempt = cmd.attempt;
  let attempts = [];
  cmd.attempt = async (...args) => { attempts.push(args[3]); return true; };
  await song.execute(sock, message, ['Artist', 'Song', '--first', 'audio'], extra);
  assert.deepEqual(attempts[0], { input: 'Artist Song', sendAs: 'audio', firstHit: true, fallback: true });
  cmd.attempt = async () => { throw new Error('YouTube link must not use Deezer'); };
  YT.getInfo = async () => ({ title: 'Song', uploader: 'Artist', duration: 200 });
  YT.downloadAudio = async (_url, { outBase }) => { const file = `${outBase}.mp3`; fs.writeFileSync(file, sourceBytes); return { file, ext: 'mp3' }; };
  await song.execute(sock, message, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'], extra);
  assert.ok(sent.some((s) => s.document));
  cmd.attempt = realAttempt;
});

test('song title falls back to YouTube if Deezer is unavailable', async () => {
  const realAttempt = cmd.attempt;
  cmd.attempt = async () => false;
  ytSearch.searchYouTube = async () => [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Song', author: 'Artist' }];
  YT.getInfo = async () => ({ title: 'Song', uploader: 'Artist', duration: 200 });
  YT.downloadAudio = async (_url, { outBase }) => { const file = `${outBase}.mp3`; fs.writeFileSync(file, sourceBytes); return { file, ext: 'mp3' }; };
  await song.execute(sock, message, ['Artist', 'Song'], extra);
  assert.ok(sent.some((s) => s.document));
  cmd.attempt = realAttempt;
});

test('Spotify uses Deezer only with expected recording metadata and falls back to YouTube', async () => {
  const realAttempt = cmd.attempt;
  let got;
  cmd.attempt = async (...args) => { got = args[3]; return false; };
  spotify.resolveTrack = async () => ({ title: 'Song', artists: 'Artist', durationMs: 200_000, isrc: 'USABC1234567', searchQuery: 'Artist - Song', type: 'track', source: 'spotify-api' });
  ytSearch.searchYouTube = async () => [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }];
  await spotifyCommand.execute(sock, message, ['https://open.spotify.com/track/example'], extra);
  assert.deepEqual(got.expected, { title: 'Song', artist: 'Artist', duration: 200, isrc: 'USABC1234567' });
  assert.equal(got.fallback, true);
  assert.equal(deliveries[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(deliveries[0].kind, 'audio');
  cmd.attempt = realAttempt;
});

test('Spotify title queries can use Deezer; links missing an artist skip it', async () => {
  const realAttempt = cmd.attempt;
  let options;
  cmd.attempt = async (...args) => { options = args[3]; return true; };
  spotify.resolveTrack = async () => ({ title: 'Artist Song', artists: '', searchQuery: 'Artist Song', source: 'query' });
  await spotifyCommand.execute(sock, message, ['Artist', 'Song'], extra);
  assert.equal(options.expected, null);
  assert.equal(deliveries.length, 0);
  options = null;
  spotify.resolveTrack = async () => ({ title: 'Song', artists: '', searchQuery: 'Song', type: 'track', source: 'spotify-oembed' });
  ytSearch.searchYouTube = async () => [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }];
  await spotifyCommand.execute(sock, message, ['https://open.spotify.com/track/example'], extra);
  assert.equal(options, null);
  assert.equal(deliveries.length, 1);
  cmd.attempt = realAttempt;
});

test('limits and picker delivery failures do not trigger YouTube fallback', async () => {
  for (const code of ['TOO_LONG', 'TOO_BIG', 'NOT_ENOUGH_DISK']) {
    responseError = Object.assign(new Error('synthetic failure'), { code });
    const handled = await cmd.attempt(sock, message, extra, { input: 'Artist Song', fallback: true });
    assert.equal(handled, true, code);
  }
  responseError = null;
  picker = true;
  const sendPrompt = selections.sendTextPrompt;
  selections.sendTextPrompt = async () => { throw new Error('delivery failed'); };
  assert.equal(await cmd.attempt(sock, message, extra, { input: 'Artist Song', fallback: true }), true);
  assert.match(sent.at(-2).text, /Could not send/);
  selections.sendTextPrompt = sendPrompt;
});

test('short or unverified previews are discarded before fallback', async () => {
  probeResult = { probed: true, hasAudio: true, duration: 30 };
  assert.equal(await cmd.attempt(sock, message, extra, { input: 'Artist Song', fallback: true }), false);
  assert.equal(sent.some((s) => s.document || s.audio), false);
  assert.ok(createdPaths.length && createdPaths.every((file) => !fs.existsSync(file)));
  probeResult = { probed: true, hasAudio: true, duration: 0 };
  assert.equal(await cmd.attempt(sock, message, extra, { input: 'Artist Song', fallback: true }), false);
});

test('mismatched Spotify recordings fall back without sending Deezer audio', async () => {
  const result = await cmd.attempt(sock, message, extra, {
    input: 'Other Song', fallback: true, firstHit: true,
    expected: { title: 'Song', artist: 'Other', duration: 200 },
  });
  assert.equal(result, false);
  assert.equal(sent.some((s) => s.document || s.audio), false);
});

test('Spotify ISRC is checked again on the full track before delivery', async () => {
  const result = await cmd.attempt(sock, message, extra, {
    input: 'Artist Song', fallback: true, firstHit: true,
    expected: { title: 'Song', artist: 'Artist', duration: 200, isrc: 'USABC1234567' },
  });
  assert.equal(result, false);
  assert.ok(createdPaths.length && createdPaths.every((file) => !fs.existsSync(file)));
  assert.equal(sent.some((s) => s.document || s.audio), false);
});

test('media menu exposes Deezer without exposing its configuration', () => {
  const text = menu._buildCard(menu._buildGroups('.', { isOwner: false }), null, { prefix: '.' });
  assert.match(text, /\.deezer/);
  assert.doesNotMatch(text, /ARL|SYNTHETIC/);
});
