'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'public-music-handler-'));
const ROOT = createBotFixture(TEMP);
const at = createRequire(path.join(ROOT, 'scripts', 'test-public-music-handler.js'));
process.chdir(TEMP);
process.env.OWNER_NUMBER = '15550000001';
process.env.PREFIX = '.';
process.env.SEARCH_RESULTS = '2';
process.env.QUEUE_MIN_FREE_MB = '0';
at('../database').getBotState = () => true;
at('../utils/telemetry')._resetForTests(null);
const policy = at('../utils/memberCommandPolicy');
const audius = at('../utils/audius');
const commons = at('../utils/commonsMedia');
const delivery = at('../utils/publicMediaDelivery');
let disabled = new Set();
let searches = [];
let deliveries = [];
let downloads = [];
const song = { id: 'abc123', title: 'First Song', artist: 'Artist', duration: 60 };
const video = { id: 1234, title: 'Bach', artist: 'Musician', duration: 32, license: 'CC BY-SA 3.0' };
policy.isUnavailable = (name) => disabled.has(name);
audius.createClient = () => ({
  async search(query, options) { searches.push({ source: 'audius', query, options }); return [song]; },
  async downloadTrack(id) { downloads.push({ source: 'audius', id }); return song; },
});
commons.createClient = () => ({
  async search(query, options) { searches.push({ source: 'commons', query, options }); return [video]; },
  async downloadItem(id, _dest, options) { downloads.push({ source: 'commons', id, options }); return video; },
});
delivery.sendPublicMedia = async (_socket, _message, _extra, options) => {
  deliveries.push(options);
  await options.download('/tmp/not-created', { maxBytes: 20000 });
};
const selections = at('../utils/selections');
const handler = at('../handler');
const socket = (id, number = '15550001111') => ({
  __sessionId: id, __accountNumber: number, user: { id: `${number}:1@s.whatsapp.net` }, sent: [],
  async sendMessage(_chat, body) { this.sent.push(body); return { key: { id: `prompt-${this.sent.length}` } }; },
});
let next = 0;
const msg = (text, fromMe = true) => ({ key: { id: `m-${++next}`, fromMe, remoteJid: 'group@g.us' }, message: { conversation: text } });
test.beforeEach(() => { disabled = new Set(); searches = []; deliveries = []; downloads = []; });
test.after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

test('actual handler registers Audius, requires prefixed owner-sent choices, and keeps selection scope', async () => {
  const first = socket('audius-first');
  const other = socket('audius-other');
  await handler.handleMessage(first, msg('.audius Artist Song'));
  assert.deepEqual(searches.map((x) => x.query), ['Artist Song']);
  const entry = selections.peek('group@g.us', ['15550001111@s.whatsapp.net'], { scope: first.__sessionId });
  assert.equal(entry.commandName, 'audius');
  await handler.handleMessage(first, msg('1'));
  await handler.handleMessage(first, msg('.1', false));
  await handler.handleMessage(other, msg('.1'));
  assert.equal(deliveries.length, 0);
  await handler.handleMessage(first, msg('.1'));
  assert.equal(deliveries[0].kind, 'audio');
  assert.deepEqual(downloads, [{ source: 'audius', id: 'abc123' }]);
});

test('Commons video first result follows the existing command dispatcher', async () => {
  const first = socket('commons-first');
  await handler.handleMessage(first, msg('.commons Bach --video --first'));
  assert.equal(searches[0].options.kind, 'video');
  assert.equal(deliveries[0].kind, 'video');
  assert.equal(downloads[0].id, 1234);
  assert.equal(downloads[0].options.kind, 'video');
  assert.equal(typeof deliveries[0].attribution, 'function');
});

test('member command switches are rechecked at selection; owners remain unaffected', async () => {
  const member = socket('member');
  await handler.handleMessage(member, msg('.audius song'));
  disabled.add('audius');
  await handler.handleMessage(member, msg('.1'));
  assert.equal(deliveries.length, 0);
  assert.match(member.sent.map((x) => x.text || '').join(' '), /temporarily unavailable/);
  const owner = socket('owner', '15550000001');
  await handler.handleMessage(owner, msg('.audius song --first'));
  assert.equal(deliveries.length, 1);
  disabled.add('commons');
  await handler.handleMessage(member, msg('.commons Bach --first'));
  assert.equal(deliveries.length, 1);
});
