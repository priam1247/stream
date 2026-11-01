'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'public-music-command-'));
const ROOT = createBotFixture(TEMP);
process.chdir(TEMP);
const at = (file) => require(path.join(ROOT, file));
const audius = at('utils/audius');
const commons = at('utils/commonsMedia');
const transfer = at('utils/mediaTransfer');
const ffmpeg = at('utils/ffmpeg');
const disk = at('utils/diskSpace');
const queue = at('utils/jobQueue');
const selections = at('utils/selections');
const telemetry = at('utils/telemetry');
const settings = at('utils/mediaSettings');
const queueLanes = [];
let prompt;
let searches;
let downloads;
let responseError;
let shortMedia;
let brokenVideo;
let audioRows;
let commonsRows;
let released;
const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12000, 3)]);
const track = { id: 'abc123', title: 'Song', artist: 'Artist', duration: 32 };
const file = { id: 1234, title: 'Bach BWV 939', artist: 'Gérard Janot', duration: 32, license: 'CC BY-SA 3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/', source: 'https://commons.wikimedia.org/wiki/File:Bach.ogv',
  credit: 'Own work', attribution: '' };

audius.createClient = () => ({
  async search(query, options) { searches.push({ source: 'audius', query, options }); if (responseError) throw responseError; return audioRows; },
  async downloadTrack(id, dest, limits) {
    downloads.push({ source: 'audius', id, dest, limits });
    if (responseError) throw responseError;
    fs.writeFileSync(dest, bytes); return track;
  },
});
commons.createClient = () => ({
  async search(query, options) { searches.push({ source: 'commons', query, options }); if (responseError) throw responseError; return commonsRows; },
  async downloadItem(id, dest, options) {
    downloads.push({ source: 'commons', id, dest, limits: options });
    if (responseError) throw responseError;
    fs.writeFileSync(dest, bytes); return file;
  },
});
queue.runInLane = async (lane, fn) => { queueLanes.push(lane); return fn(); };
disk.reserveMediaSpace = () => ({ release() { released++; } });
disk.requireMediaCopySpace = () => {};
telemetry.recordDownloadSuccess = () => {};
telemetry.recordFailure = () => {};
settings.get = (_key, fallback) => fallback;
selections.sendTextPrompt = async (_sock, _msg, _extra, value) => { prompt = value; };
ffmpeg.works = () => true;
transfer.sniffFile = () => ({ kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' });
transfer.tagMp3 = async (input, output) => { fs.copyFileSync(input, output); return output; };
transfer.audioToMp3 = async (input, output) => { fs.copyFileSync(input, output); return output; };
transfer.probeMedia = async (name) => ({
  probed: true, hasAudio: !brokenVideo || !name.endsWith('_video.mp4'), hasVideo: true,
  container: name.endsWith('_video.mp4') ? 'mov,mp4' : 'ogg',
  audioCodec: name.endsWith('_video.mp4') ? 'aac' : 'mp3',
  videoCodec: name.endsWith('_video.mp4') ? 'h264' : 'theora', duration: shortMedia ? 4 : 32,
});
transfer.ensureWhatsAppMp4 = async (input, output) => { fs.copyFileSync(input, output); return output; };
const delivery = at('utils/publicMediaDelivery');
const commands = at('commands/media/publicMusic');
const audiusCommand = commands.find((c) => c.name === 'audius');
const commonsCommand = commands.find((c) => c.name === 'commons');
const msg = { key: { remoteJid: 'self@s.whatsapp.net', id: '1' }, message: {} };
const extra = { from: 'self@s.whatsapp.net', sender: 'self@s.whatsapp.net', isOwner: false };
let sent;
const sock = { async sendMessage(_chat, body) {
  const media = body.document || body.audio || body.video;
  if (media) assert.ok(fs.existsSync(media.url), 'temp file must exist while sending');
  sent.push(body);
} };

test.after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
test.beforeEach(() => {
  prompt = null; searches = []; downloads = []; sent = []; queueLanes.length = 0;
  responseError = null; shortMedia = false; brokenVideo = false; released = 0;
  audioRows = [track]; commonsRows = [file]; ffmpeg.works = () => true;
});

test('Audius title search, picker, chosen id and document delivery use the proper queues', async () => {
  await audiusCommand.execute(sock, msg, ['Artist', 'Song', 'audio'], extra);
  assert.equal(searches[0].query, 'Artist Song audio', 'bare audio is part of the title');
  assert.equal(prompt.items.length, 1);
  assert.match(prompt.text, /\.1/);
  await prompt.run(sock, msg, extra, prompt.items[0]);
  assert.equal(downloads[0].id, 'abc123');
  assert.equal(downloads[0].limits.maxBytes, 120 * 1024 * 1024);
  assert.deepEqual(queueLanes, ['search', 'light']);
  const body = sent.find((item) => item.document);
  assert.equal(body.fileName, 'Artist - Song.mp3');
  assert.match(body.caption, /via Audius/);
  assert.equal(fs.existsSync(body.document.url), false);
  assert.equal(released, 1);
});

test('Audius first result can send a normal audio message', async () => {
  await audiusCommand.execute(sock, msg, ['Song', '--first', '--as-audio'], extra);
  assert.equal(prompt, null);
  assert.equal(sent.find((item) => item.audio).mimetype, 'audio/mpeg');
  assert.equal(sent.some((item) => item.document), false);
});

test('Commons music video keeps its license and source with the delivered video', async () => {
  await commonsCommand.execute(sock, msg, ['Bach', '--video'], extra);
  assert.equal(searches[0].options.kind, 'video');
  assert.match(prompt.text, /CC BY-SA 3\.0/);
  await prompt.run(sock, msg, extra, prompt.items[0]);
  assert.equal(downloads[0].id, 1234);
  assert.equal(downloads[0].limits.kind, 'video');
  assert.deepEqual(queueLanes, ['search', 'heavy']);
  const body = sent.find((item) => item.video);
  assert.equal(body.mimetype, 'video/mp4');
  assert.match(body.caption, /CC BY-SA 3\.0/);
  assert.match(body.caption, /commons\.wikimedia\.org\/wiki\/File/);
  assert.match(body.caption, /Converted or tagged/);
  assert.equal(fs.existsSync(body.video.url), false);
});

test('Commons playable audio gets a separate credit before the audio', async () => {
  await commonsCommand.execute(sock, msg, ['Bach', '--first', '--audio', '--as-audio'], extra);
  const index = sent.findIndex((item) => item.audio);
  assert.ok(index > 0);
  assert.match(sent[index - 1].text, /License: CC BY-SA 3\.0/);
  assert.match(sent[index - 1].text, /Source: https:\/\/commons/);
});

test('both shortcuts reject pasted URLs and overlong titles without searching', async () => {
  for (const [command, args] of [[audiusCommand, ['https://audius.co/artist/song']], [commonsCommand, ['example.org/file']]]) {
    await command.execute(sock, msg, args, extra);
    assert.match(sent.at(-1).text, /searches titles only.*\.dl/);
  }
  const quoted = { ...msg, message: { extendedTextMessage: { contextInfo: { quotedMessage: { conversation: 'https://example.org/file' } } } } };
  await audiusCommand.execute(sock, quoted, [], extra);
  assert.match(sent.at(-1).text, /searches titles only/);
  await audiusCommand.execute(sock, msg, ['x'.repeat(201)], extra);
  assert.match(sent.at(-1).text, /200 characters/);
  assert.equal(searches.length, 0);
});

test('no results, search failure and revoked downloads give safe messages without fallback', async () => {
  audioRows = [];
  await audiusCommand.execute(sock, msg, ['Song'], extra);
  assert.match(sent.at(-1).text, /No Audius tracks/);
  responseError = new Error('signed-url-SECRET');
  await commonsCommand.execute(sock, msg, ['Bach'], extra);
  assert.match(sent.at(-1).text, /search is unavailable/);
  assert.doesNotMatch(JSON.stringify(sent), /SECRET/);
  responseError = null;
  audioRows = [track];
  await audiusCommand.execute(sock, msg, ['Song'], extra);
  responseError = Object.assign(new Error('SECRET'), { code: 'MEDIA_UNAVAILABLE' });
  await prompt.run(sock, msg, extra, prompt.items[0]);
  assert.match(sent.find((item) => item.text?.includes('no longer available')).text, /permitted/);
  assert.equal(sent.some((item) => item.document || item.audio), false);
  assert.doesNotMatch(JSON.stringify(sent), /SECRET/);
  assert.equal(released, 1);
});

test('missing FFmpeg, incomplete audio and broken video are not sent and cleanup still runs', async () => {
  ffmpeg.works = () => false;
  await audiusCommand.execute(sock, msg, ['Song', '--first'], extra);
  assert.ok(sent.some((s) => s.text?.includes('Could not verify')));
  assert.equal(downloads.length, 0);
  ffmpeg.works = () => true;
  sent = []; shortMedia = true;
  await audiusCommand.execute(sock, msg, ['Song', '--first'], extra);
  assert.equal(sent.some((s) => s.document || s.audio), false);
  assert.equal(fs.existsSync(downloads.at(-1).dest), false);
  sent = []; shortMedia = false; brokenVideo = true;
  await commonsCommand.execute(sock, msg, ['Bach', '--video', '--first'], extra);
  assert.equal(sent.some((s) => s.video), false);
  assert.equal(fs.existsSync(downloads.at(-1).dest), false);
});

test('delivery helpers reject bad duration and missing streams', () => {
  assert.equal(delivery.verified({ probed: true, hasAudio: true, duration: 32 }, { duration: 32 }, 'audio', 60), true);
  assert.equal(delivery.verified({ probed: true, hasAudio: true, duration: 4 }, { duration: 32 }, 'audio', 60), false);
  assert.equal(delivery.verified({ probed: true, hasAudio: true, hasVideo: false, duration: 32 }, { duration: 32 }, 'video', 60), false);
  assert.equal(delivery.verified({ probed: true, hasAudio: true, duration: 300 }, { duration: 32 }, 'audio', 60), false);
});
