'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-routing-'));
const first = path.join(TMP, 'first');
const second = path.join(TMP, 'second');
fs.mkdirSync(first); fs.mkdirSync(second);
// The same LID is intentionally different on each account. A mapping learned by
// one session must never grant access to somebody on another session.
fs.writeFileSync(path.join(first, 'lid-mapping-900000_reverse.json'), JSON.stringify('15550000001'));
fs.writeFileSync(path.join(second, 'lid-mapping-900000_reverse.json'), JSON.stringify('15550001111'));
process.env.OWNER_NUMBER = '15550000001';
process.env.ADMIN_NUMBERS = '15550000002';
// Even an old cooldown setting must not throttle commands.
process.env.COMMAND_COOLDOWN_MS = '60000';

const access = require('../utils/accessControl');
access.readWL = () => ({ users: [{ number: '15550001111', enabled: true }] });
const database = require('../database');
let switches = [];
database.getBotState = () => true;
database.setBotState = (value) => { switches.push(value); return true; };
const handler = require('../handler');
const selections = require('../utils/selections');
const { jidVariants } = require('../utils/jid');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function socket(dir, id) {
  const sent = [];
  return {
    __sessionId: id,
    __sessionDir: dir,
    ...(id === 'primary' ? {} : { __accountNumber: '15550001111' }),
    user: { id: id === 'primary' ? '15550000001:1@s.whatsapp.net' : '15550001111:1@s.whatsapp.net' },
    sent,
    sendMessage: async (_chat, content) => { sent.push(content); return { key: { id: 'prompt-1' } }; },
  };
}
function msg(text, id) {
  return { key: { remoteJid: 'group@g.us', participant: '900000@lid', remoteJidAlt: '15550000001@s.whatsapp.net', fromMe: true, id }, message: { conversation: text } };
}

test('linked-account identity resolution is isolated and never grants administrator privileges', async () => {
  const owner = socket(first, 'primary');
  const member = socket(second, 'linked:15550009999');
  assert.ok(jidVariants('900000@lid', first).has('15550000001'));
  assert.ok(jidVariants('900000@lid', second).has('15550001111'));
  assert.equal(jidVariants('900000@lid', second).has('15550000001'), false);

  await handler.handleMessage(member, msg('.off', 'member-off'));
  assert.deepEqual(switches, [], 'linking must not confer administrator privileges');
  assert.match(member.sent.map((m) => m.text || '').join(' '), /restricted/i);
  await handler.handleMessage(member, msg('.ping', 'member-ping'));
  assert.match(member.sent.map((m) => m.text || '').join(' '), /pong/i, 'the approved member can use ordinary commands');
  await handler.handleMessage(owner, msg('.off', 'owner-off'));
  assert.deepEqual(switches, [false], 'an actual configured administrator keeps existing access');
});

test('only the session owner may issue prefixed commands, with no cooldown', async () => {
  const member = socket(second, 'linked:15550009999');
  await handler.handleMessage(member, { ...msg('.ping', 'other'), key: { ...msg('.ping', 'other').key, fromMe: false } });
  await handler.handleMessage(member, msg('https://example.com/movie', 'url'));
  await handler.handleMessage(member, msg('hello', 'plain'));
  assert.equal(member.sent.length, 0, 'strangers and unprefixed messages must be ignored');
  for (const id of ['one', 'two', 'three']) await handler.handleMessage(member, msg('.ping', id));
  assert.equal(member.sent.filter((content) => /pong/i.test(content.text || '')).length, 3);
});

test('an unprefixed message never produces an error reply when other state is broken', async () => {
  const member = socket(second, 'linked:15550009999');
  const original = database.getBotState;
  database.getBotState = () => { throw new Error('unavailable'); };
  try {
    await handler.handleMessage(member, msg('plain text', 'plain-with-broken-state'));
    assert.equal(member.sent.length, 0);
  } finally { database.getBotState = original; }
});

test('choices and quoted replies from the same chat do not cross account boundaries', () => {
  const chatId = 'group@g.us';
  const sender = '900000@lid';
  const run = () => {};
  const common = { chatId, sender, run, promptMessageId: 'same-prompt' };
  const offerA = selections.offer({ ...common, scope: 'primary', sessionDir: first, items: ['first'] });
  const offerB = selections.offer({ ...common, scope: 'linked:15550009999', sessionDir: second, items: ['second'] });
  assert.equal(selections.match(chatId, sender, `${offerB}:1`, { scope: 'primary', sessionDir: first }), null);
  const a = selections.match(chatId, sender, '1', { scope: 'primary', sessionDir: first, quotedMessageId: 'same-prompt' });
  assert.equal(a.item, 'first');
  const b = selections.match(chatId, sender, '1', { scope: 'linked:15550009999', sessionDir: second, quotedMessageId: 'same-prompt' });
  assert.equal(b.item, 'second');
  assert.notEqual(offerA, offerB);
});

test('member maintenance policy covers aliases and outstanding selections, while owners can test', async () => {
  const policy = require('../utils/memberCommandPolicy');
  const file = path.join(__dirname, '..', 'database', 'member-command-policy.json');
  const saved = [file, `${file}.bak`].map((name) => fs.existsSync(name) ? fs.readFileSync(name) : null);
  try {
    policy.apply(['ping'], policy.versionFor(['ping']));
    const member = socket(second, 'linked:15550009999');
    const owner = socket(first, 'primary');
    await handler.handleMessage(member, msg('.p', 'member-alias'));
    assert.match(member.sent.map((value) => value.text || '').join(' '), /temporarily unavailable/i);
    await handler.handleMessage(owner, msg('.ping', 'owner-test'));
    assert.match(owner.sent.map((value) => value.text || '').join(' '), /pong/i);
    let ran = false;
    selections.offer({ chatId: 'group@g.us', sender: [member.__accountNumber + '@s.whatsapp.net', member.user.id], scope: member.__sessionId,
      sessionDir: second, commandName: 'p', items: ['one'], run: async () => { ran = true; } });
    await handler.handleMessage(member, msg('.1', 'disabled-selection'));
    assert.equal(ran, false);
    assert.match(member.sent.map((value) => value.text || '').join(' '), /temporarily unavailable/i);
    policy.apply(['bilibili'], policy.versionFor(['bilibili']));
    member.sent.length = 0;
    owner.sent.length = 0;
    await handler.handleMessage(member, msg('.bili', 'member-bili-alias'));
    assert.match(member.sent.map((value) => value.text || '').join(' '), /temporarily unavailable/i);
    await handler.handleMessage(owner, msg('.bili', 'owner-bili-alias'));
    assert.match(owner.sent.map((value) => value.text || '').join(' '), /usage/i);
    policy.apply([], policy.versionFor([]));
    await handler.handleMessage(member, msg('.p', 'enabled-alias'));
    assert.match(member.sent.map((value) => value.text || '').join(' '), /pong/i);
  } finally {
    [file, `${file}.bak`].forEach((name, index) => saved[index] ? fs.writeFileSync(name, saved[index]) : fs.rmSync(name, { force: true }));
  }
});

test('hot reload retains account sockets and delivery state while updating handlers', async () => {
  process.env.FAKE_YTDLP = '1';
  process.env.NM3U8DL_DISABLE_AUTOINSTALL = '1';
  const policy = require('../utils/memberCommandPolicy');
  const sockets = require('../utils/accountSockets');
  const delivery = require('../utils/jobDelivery');
  const sock = socket(second, 'linked:15550009999');
  sockets.setOnline(sock.__sessionId, sock);
  const { reloadRuntime } = require('../utils/hotReload');
  const result = reloadRuntime();
  assert.ok(result.evicted > 0);
  assert.strictEqual(require('../utils/accountSockets'), sockets);
  assert.strictEqual(require('../utils/memberCommandPolicy'), policy);
  assert.strictEqual(require('../utils/jobDelivery'), delivery);
  assert.strictEqual(sockets.getOnline(sock.__sessionId), sock);
  await result.handler.handleMessage(sock, msg('.ping', 'after-reload'));
  assert.match(sock.sent.map((m) => m.text || '').join(' '), /pong/i);
  sockets.setOffline(sock.__sessionId, sock);
});
