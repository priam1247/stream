'use strict';

/**
 * test/guards.test.js — Phase 4B: the guard order, proven in order.
 *
 * Guards are evaluated against real store files in a disposable HOME-like
 * sandbox? No: the store is rooted at the repo's storage/. These tests use two
 * dedicated test numbers and reset their records before each case, so they never
 * touch a real linked number's data.
 *
 * Test numbers: 265900000001 (the "linked" number) and 265900000002.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'gateway/users/store'));
const guards = require(path.join(ROOT, 'gateway/guards'));
const usage = require(path.join(ROOT, 'gateway/users/usage'));

const NUMBER_A = '265900000001';
const NUMBER_B = '265900000002';
const OWNER = '265900000009';

function resetNumber(number) {
  fs.rmSync(path.join(ROOT, 'storage/core/numbers', number), { recursive: true, force: true });
  store.ensureNumber(number);
}

function command({ role = 'user', cooldownSec = 0 } = {}) {
  return { name: 'ping', meta: { role, cooldownSec }, folderPath: '/dev/null' };
}

function evaluate({
  sender, fromMe = true, number = NUMBER_A, cmd = command(),
  isGroup = false, groupEnabled = true, chatKind = 'dm', jid: customJid = null,
}) {
  return guards.evaluate({
    message: {
      fromMe,
      isGroup,
      groupEnabled,
      chatKind,
      chat: customJid || `${number}@s.whatsapp.net`,
      sender: customJid || `${sender}@s.whatsapp.net`,
    },
    number,
    command: cmd,
  });
}

test.before(() => {
  store.writeOwner(OWNER);
});

test.beforeEach(() => {
  resetNumber(NUMBER_A);
  resetNumber(NUMBER_B);
  usage._resetAll();
});

/* 1 ─ fromMe */

test('guard 1: a stranger is ignored with no reply', () => {
  // Not our number, not approved on it: silence. Replying would confirm the bot
  // is listening.
  const verdict = evaluate({ sender: '265900000005', fromMe: false });
  assert.equal(verdict.mode, 'ignore');
  assert.equal(verdict.reason, 'not-approved');
});

test('guard 1: an approved person in a direct chat is served', () => {
  store.addUser(NUMBER_A, '265900000005', { role: 'user' });
  const verdict = evaluate({ sender: '265900000005', fromMe: false });
  assert.equal(verdict.mode, 'replay', 'approval, not fromMe, is what lets somebody in');
});

test('guard 1: a message with no sender is ignored', () => {
  const verdict = guards.evaluate({ message: { fromMe: true, chat: 'x', sender: '' }, number: NUMBER_A, command: command() });
  assert.equal(verdict.reason, 'no-sender');
});

/* 2 ─ ban */

test('guard 2: a banned user is stopped silently, with no reply', () => {
  store.addUser(NUMBER_A, '265900000005');
  store.banUser(NUMBER_A, '265900000005');
  const verdict = evaluate({ sender: '265900000005' });
  assert.equal(verdict.mode, 'ignore', 'a ban must produce no message at all');
  assert.equal(verdict.reason, 'banned');
});

test('guard 2: the owner cannot be banned, so the ban guard never applies to them', () => {
  // The owner is global and outranks every per-number record. store.banUser
  // still records role=banned, but the owner file wins. This is deliberate: an
  // admin on one number must not be able to lock the owner out.
  store.addUser(NUMBER_A, OWNER);
  store.banUser(NUMBER_A, OWNER);
  const verdict = evaluate({ sender: OWNER });
  assert.equal(verdict.mode, 'replay', 'the owner must pass even with a banned record');
});

test('guard 2: banned outranks the access mode (still silent under whitelist)', () => {
  store.setAccessMode(NUMBER_A, 'whitelist');
  store.addUser(NUMBER_A, '265900000005');
  store.banUser(NUMBER_A, '265900000005');
  assert.equal(evaluate({ sender: '265900000005' }).mode, 'ignore');
});

/* 3 ─ access mode */

test('guard 3: an unapproved person is refused, and told nothing', () => {
  store.setAccessMode(NUMBER_A, 'whitelist');
  const verdict = evaluate({ sender: '265900000005' });
  assert.equal(verdict.mode, 'ignore', 'a stranger gets no message at all');
  assert.equal(verdict.reason, 'not-approved');
});

test('guard 3: an approved user is let through', () => {
  store.addUser(NUMBER_A, '265900000005');
  assert.equal(evaluate({ sender: '265900000005' }).mode, 'replay');
});

test('guard 3: accessMode "open" no longer admits anyone', () => {
  // The open door is gone on purpose. Kept as a test because a future refactor
  // might reintroduce it by accident.
  store.setAccessMode(NUMBER_A, 'open');
  assert.equal(evaluate({ sender: '265900000005' }).mode, 'ignore');
});

/* 4 ─ maintenance */

test('guard 4: maintenance blocks a plain user', () => {
  store.addUser(NUMBER_A, '265900000005', { role: 'user' });
  store.setMaintenance(NUMBER_A, true);
  const verdict = evaluate({ sender: '265900000005' });
  assert.equal(verdict.reason, 'maintenance');
  assert.equal(verdict.mode, 'not-authorized');
});

test('guard 4: maintenance lets an admin through', () => {
  store.addUser(NUMBER_A, '265900000006', { role: 'admin' });
  store.setMaintenance(NUMBER_A, true);
  assert.equal(evaluate({ sender: '265900000006' }).mode, 'replay');
});

/* 5 ─ role */

test('guard 5: an admin command refuses a plain user', () => {
  store.addUser(NUMBER_A, '265900000005', { role: 'user' });
  const verdict = evaluate({ sender: '265900000005', cmd: command({ role: 'admin' }) });
  assert.equal(verdict.reason, 'role-too-low');
  assert.equal(verdict.mode, 'not-authorized');
});

test('guard 5: an owner command refuses an admin', () => {
  store.addUser(NUMBER_A, '265900000006', { role: 'admin' });
  const verdict = evaluate({ sender: '265900000006', cmd: command({ role: 'owner' }) });
  assert.equal(verdict.reason, 'role-too-low');
});

test('guard 5: the owner passes an owner command on every number', () => {
  assert.equal(evaluate({ sender: OWNER, cmd: command({ role: 'owner' }) }).mode, 'replay');
  assert.equal(evaluate({ sender: OWNER, number: NUMBER_B, cmd: command({ role: 'owner' }) }).mode, 'replay',
    'the owner is global, so a number with no record for them must still accept them');
});

/* 6 ─ per-command block */

test('guard 6: a per-command block stops exactly one command', () => {
  store.addUser(NUMBER_A, '265900000005');
  store.blockCommand(NUMBER_A, '265900000005', 'ping');

  const blocked = evaluate({ sender: '265900000005', cmd: command() });
  assert.equal(blocked.reason, 'blocked-command');

  // The same user, a different command, must still pass.
  const other = guards.evaluate({
    message: { fromMe: true, chat: `${NUMBER_A}@s.whatsapp.net`, sender: '265900000005@s.whatsapp.net' },
    number: NUMBER_A,
    command: { name: 'menu', meta: { role: 'user', cooldownSec: 0 }, folderPath: '/dev/null' },
  });
  assert.equal(other.mode, 'replay', 'a block on one command must not affect another');
});

/* 7 ─ cooldown */

test('guard 7: cooldown refuses the second run, then expires', () => {
  const cmd = command({ cooldownSec: 2 });
  usage._resetAll();
  store.addUser(NUMBER_A, '265900000005');

  assert.equal(evaluate({ sender: '265900000005', cmd }).mode, 'replay', 'first run must pass');
  usage.mark(NUMBER_A, '265900000005', 'ping');

  const second = evaluate({ sender: '265900000005', cmd });
  assert.equal(second.reason, 'cooldown');
  assert.equal(second.mode, 'not-authorized');
  assert.ok(second.retryInSec >= 1 && second.retryInSec <= 2, `retryInSec was ${second.retryInSec}`);

  usage.reset(NUMBER_A, '265900000005', 'ping');
  assert.equal(evaluate({ sender: '265900000005', cmd }).mode, 'replay', 'after the cooldown the run must pass again');
});

test('cooldown is per user and per command, not global', () => {
  const cmd = command({ cooldownSec: 60 });
  store.addUser(NUMBER_A, '265900000005');
  store.addUser(NUMBER_A, '265900000007');
  usage.mark(NUMBER_A, '265900000005', 'ping');
  // Another user is unaffected.
  assert.equal(evaluate({ sender: '265900000007', cmd }).mode, 'replay');
  // Another command is unaffected.
  const other = guards.evaluate({
    message: { fromMe: true, chat: `${NUMBER_A}@s.whatsapp.net`, sender: '265900000005@s.whatsapp.net' },
    number: NUMBER_A,
    command: { name: 'menu', meta: { role: 'user', cooldownSec: 60 }, folderPath: '/dev/null' },
  });
  assert.equal(other.mode, 'replay');
});

/* order itself */

test('the guards fire in the documented order, not in whatever order is convenient', () => {
  // A banned user in whitelist mode requesting an owner command with a cooldown:
  // the ban must win (silence), not the whitelist message, not the role refusal.
  // (Non-owner user: the global owner is exempt from bans by design.)
  store.setAccessMode(NUMBER_A, 'whitelist');
  store.addUser(NUMBER_A, '265900000005');
  store.banUser(NUMBER_A, '265900000005');
  usage.mark(NUMBER_A, '265900000005', 'ping');

  const verdict = evaluate({ sender: '265900000005', cmd: command({ role: 'owner', cooldownSec: 60 }) });
  assert.equal(verdict.reason, 'banned', 'ban must outrank access mode, role and cooldown');

  // Remove the ban: next in line is the role check, not the cooldown.
  store.unbanUser(NUMBER_A, '265900000005');
  const after = evaluate({ sender: '265900000005', cmd: command({ role: 'owner', cooldownSec: 60 }) });
  assert.equal(after.reason, 'role-too-low', 'role must outrank cooldown');
});

/* refusal wording */

test('every refusal has one fixed, polite message', () => {
  assert.match(guards.refusalText('not-approved'), /not authorized/i);
  assert.match(guards.refusalText('maintenance'), /maintenance/i);
  assert.match(guards.refusalText('role-too-low'), /restricted/i);
  assert.match(guards.refusalText('blocked-command'), /not allowed/i);
  assert.match(guards.refusalText('cooldown', { retryInSec: 7 }), /7s/);
});
