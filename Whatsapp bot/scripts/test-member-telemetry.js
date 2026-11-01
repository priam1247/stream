'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-usage-'));
const bot = createBotFixture(root);
const botRequire = createRequire(path.join(bot, 'scripts', 'test-member-telemetry.js'));
process.chdir(root);
const usage = botRequire('../utils/memberTelemetry');
const database = botRequire('../database');
database.getBotState = () => true;
const handler = botRequire('../handler');
const file = path.join(root, 'usage.json');
const a = { number: '265991111111', sessionId: 'a'.repeat(24), claimToken: 'a'.repeat(64) };
const b = { number: '265992222222', sessionId: 'b'.repeat(24), claimToken: 'b'.repeat(64) };
const allow = [{ number: a.number, backupClaim: a.claimToken }, { number: b.number, backupClaim: b.claimToken }];
test.after(() => { usage._resetForTests(null); fs.rmSync(root, { recursive: true, force: true }); });

function socket(scope) {
  return {
    __accountNumber: scope.number, __sessionId: `linked:${scope.number}`, __memberUsageScope: () => scope,
    user: { id: `${scope.number}:1@s.whatsapp.net` },
    sendMessage: async () => ({ key: { id: 'reply' } }),
  };
}
function message(body, fromMe = true) {
  return { key: { fromMe, remoteJid: 'chat@s.whatsapp.net', id: 'message' }, message: { conversation: body } };
}

test('records only authorized command names for the exact account and claim', async () => {
  usage._resetForTests(file);
  const member = socket(a);
  await handler.handleMessage(member, message('.p private search text'));
  await handler.handleMessage(member, message('.off secret-not-a-command'));
  await handler.handleMessage(member, message('.ping ignored', false));
  await handler.handleMessage(member, message('ordinary private message'));
  member.__canRespond = () => false;
  await handler.handleMessage(member, message('.ping paused'));
  await handler.handleMessage(socket(b), message('.ping'));
  const snapshot = usage.snapshot(allow);
  assert.equal(snapshot.sessions.length, 2);
  const first = snapshot.sessions.find((session) => session.number === a.number);
  const second = snapshot.sessions.find((session) => session.number === b.number);
  assert.deepEqual(first.days[0].commands, { ping: 1 });
  assert.deepEqual(second.days[0].commands, { ping: 1 });
  assert.equal(first.lastCommand, 'ping');
  assert.doesNotMatch(JSON.stringify(snapshot), /private|search|secret|chat/);
  assert.equal(usage.snapshot([{ number: a.number, backupClaim: 'c'.repeat(64) }]).sessions.length, 0, 'a transferred claim must not inherit history');
  usage.flushNow();
  usage._resetForTests(file);
  assert.deepEqual(usage.snapshot(allow), snapshot, 'counts and tracking start survive a restart');
});

test('rejects malformed scopes and caps retained sessions and command names', () => {
  usage._resetForTests(null);
  usage.recordCommand('ping', { ...a, sessionId: 'invalid' });
  usage.recordCommand('ping', { ...a, claimToken: 'invalid' });
  usage.recordCommand('bad command with arguments', a);
  assert.deepEqual(usage.snapshot(allow).sessions, []);
  for (let i = 0; i < 80; i++) usage.recordCommand(`command${i}`, a);
  const day = usage.snapshot(allow).sessions[0].days[0];
  assert.ok(Object.keys(day.commands).length <= 64);
  assert.equal(Object.values(day.commands).reduce((sum, value) => sum + value, 0), 80);
  assert.equal(day.commands.other, 17);
});
