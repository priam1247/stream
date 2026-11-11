'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-routing-'));
const BOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(BOT, 'scripts', 'test-account-routing.js'));
process.chdir(TMP);
botRequire('../lib/telemetry')._resetForTests(null);
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

const access = botRequire('../gateway/users/access');
access.readWL = () => ({ users: [{ number: '15550001111', enabled: true }] });
const database = botRequire('../lib/database');
let switches = [];
database.getBotState = () => true;
database.setBotState = (value) => { switches.push(value); return true; };
const handler = botRequire('../gateway/handler');
const selections = botRequire('../lib/selections');
const { jidVariants } = botRequire('../lib/jid');

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

test('linked accounts can invoke commands without dashboard command switches', async () => {
  const member = socket(second, 'linked:15550009999');
  await handler.handleMessage(member, msg('.p', 'member-no-policy'));
  assert.match(member.sent.map((value) => value.text || '').join(' '), /pong/i);
});

test('hot reload retains account sockets and delivery state while updating handlers', async () => {
  process.env.FAKE_YTDLP = '1';
  process.env.NM3U8DL_DISABLE_AUTOINSTALL = '1';
  const sockets = botRequire('../lib/accountSockets');
  const delivery = botRequire('../lib/jobDelivery');
  const sock = socket(second, 'linked:15550009999');
  sockets.setOnline(sock.__sessionId, sock);
  const { reloadRuntime } = botRequire('../lib/hotReload');
  const result = reloadRuntime();
  assert.ok(result.evicted > 0);
  assert.strictEqual(botRequire('../lib/accountSockets'), sockets);
  assert.strictEqual(botRequire('../lib/jobDelivery'), delivery);
  assert.strictEqual(sockets.getOnline(sock.__sessionId), sock);
  await result.handler.handleMessage(sock, msg('.ping', 'after-reload'));
  assert.match(sock.sent.map((m) => m.text || '').join(' '), /pong/i);
  sockets.setOffline(sock.__sessionId, sock);
});

test('restart survives failed acknowledgements and stays locked across a command reload', async (t) => {
  const hotReload = botRequire('../lib/hotReload');
  const modulePath = botRequire.resolve('../commands/botmanage/index');
  const originalReload = hotReload.reloadRuntime;
  let reloads = 0, ended = 0;
  hotReload.reloadRuntime = () => { reloads += 1; delete require.cache[modulePath]; return { ok: true }; };
  t.after(() => { hotReload.reloadRuntime = originalReload; hotReload.finishRestart?.(); });
  const sock = { sendMessage: async () => ({}), end: () => { ended += 1; } };
  const message = { key: { remoteJid: 'chat@s.whatsapp.net' } };
  const first = require(modulePath).find((command) => command.name === 'restart');
  await first.execute(sock, message, [], { reply: async () => { throw new Error('temporary reply failure'); } });
  const second = require(modulePath).find((command) => command.name === 'restart');
  const replies = [];
  await second.execute(sock, message, [], { reply: async (text) => { replies.push(text); } });
  assert.equal(reloads, 1, 'a reload must not reset the in-progress guard');
  assert.match(replies.join(' '), /restart in progress/i);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(ended, 1);
  assert.equal(hotReload.beginRestart(), true, 'the guard is released after reconnect is requested');
  hotReload.finishRestart();
});

test('restart releases its guard if runtime reload fails', async (t) => {
  const hotReload = botRequire('../lib/hotReload');
  const originalReload = hotReload.reloadRuntime;
  hotReload.reloadRuntime = () => { throw new Error('reload failed'); };
  t.after(() => { hotReload.reloadRuntime = originalReload; hotReload.finishRestart?.(); });
  const sock = { sendMessage: async () => ({}) };
  const command = botRequire('../commands/botmanage/index').find((item) => item.name === 'restart');
  await assert.rejects(command.execute(sock, { key: { remoteJid: 'chat@s.whatsapp.net' } }, [], { reply: async () => {} }), /reload failed/);
  assert.equal(hotReload.beginRestart(), true);
  hotReload.finishRestart();
});

test('a non-Error rejection from WhatsApp is handled without crashing the message handler', async () => {
  const member = socket(second, 'linked:15550009999');
  let calls = 0;
  member.sendMessage = async (_chat, content) => {
    calls += 1;
    if (calls === 1) throw null;
    member.sent.push(content);
    return { key: { id: 'recovery' } };
  };
  await assert.doesNotReject(handler.handleMessage(member, msg('.off', 'non-error-rejection')));
  assert.equal(member.sent.length, 1);
  assert.match(member.sent[0].text, /wrong|try again/i);
});
