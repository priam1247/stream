'use strict';

/**
 * test/access.test.js — who the bot answers, and only once.
 *
 * The rule from the owner:
 *   - answer APPROVED linked users only, never the public
 *   - when several linked numbers share a group, exactly one replies, and it is
 *     the number that sent the message
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'gateway/users/store'));
const access = require(path.join(ROOT, 'gateway/users/access'));
const dedupe = require(path.join(ROOT, 'gateway/dedupe'));

const OWNER = '265900000301';
const MY_NUMBER = '265900000302';
const MY_OTHER = '265900000303';
const STUDENT = '265900000311';
const STRANGER = '265900000399';

function settings(over = {}) {
  return { accessMode: 'whitelist', maintenance: false, prefix: null, groups: [], ...over };
}

function ask({ sender, requiredRole = 'user', user = null, st = settings(), ownerNumber = OWNER }) {
  return access.canRun({
    number: MY_NUMBER,
    userNumber: sender,
    settings: st,
    requiredRole,
    command: 'paper',
    user,
    ownerNumber,
  });
}

/* ── strangers get nothing ──────────────────────────────────────────────── */

test('a stranger with no record is refused and told nothing', () => {
  const verdict = ask({ sender: STRANGER });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'not-approved');
});

test('there is no open mode that lets a stranger in', () => {
  // Even with accessMode 'open', an unapproved sender is refused: the open mode
  // no longer exists as a way in.
  const verdict = ask({ sender: STRANGER, st: settings({ accessMode: 'open' }) });
  assert.equal(verdict.allowed, false, 'accessMode must not open the door to anyone');
  assert.equal(verdict.reason, 'not-approved');
});

test('an approved student gets paper but not admin commands', () => {
  const student = { number: STUDENT, role: 'user', status: 'active', blockedCommands: [] };
  assert.equal(ask({ sender: STUDENT, user: student }).allowed, true);
  const admin = ask({ sender: STUDENT, user: student, requiredRole: 'admin' });
  assert.equal(admin.allowed, false);
  assert.equal(admin.reason, 'role-too-low');
});

test('a banned student is refused', () => {
  const banned = { number: STUDENT, role: 'banned', status: 'banned', blockedCommands: [] };
  const verdict = ask({ sender: STUDENT, user: banned });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'banned');
});

test('the global owner passes on every number', () => {
  assert.equal(ask({ sender: OWNER, requiredRole: 'owner' }).allowed, true);
});

test('a linked number is served even with no record of its own', () => {
  // Caught by scripts/demo-access.js: the router knew the sender was ours but
  // access.js had no way to know, so the owner was refused on their own phone.
  const verdict = access.canRun({
    number: MY_NUMBER,
    userNumber: MY_OTHER,
    settings: settings(),
    requiredRole: 'user',
    command: 'paper',
    user: null,
    ownerNumber: OWNER,
    linked: [MY_NUMBER, MY_OTHER],
  });
  assert.equal(verdict.allowed, true, 'one of our own numbers must always be served');
});

test('one of our own linked numbers is always served', () => {
  const linked = { number: MY_NUMBER, role: 'admin', status: 'active', blockedCommands: [] };
  assert.equal(ask({ sender: MY_NUMBER, user: linked }).allowed, true);
});

test('approval on one number does not approve on another', () => {
  // access.canRun is per-number by construction; prove the store agrees.
  fs.rmSync(path.join(ROOT, 'storage/core/numbers', MY_NUMBER), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'storage/core/numbers', MY_OTHER), { recursive: true, force: true });
  store.ensureNumber(MY_NUMBER);
  store.ensureNumber(MY_OTHER);
  store.addUser(MY_NUMBER, STUDENT);

  assert.notEqual(store.getUser(MY_NUMBER, STUDENT), null);
  assert.equal(store.getUser(MY_OTHER, STUDENT), null);
  assert.equal(ask({ sender: STUDENT, user: null }).allowed, false, 'a different number must not serve them');
});

/* ── exactly one responder ──────────────────────────────────────────────── */

test.beforeEach(() => dedupe._reset());

test('one message in a group is answered exactly once', () => {
  const linked = [MY_NUMBER, MY_OTHER];
  const first = dedupe.claimResponder({ id: 'MSG1', sender: STUDENT, number: MY_NUMBER, linked });
  const second = dedupe.claimResponder({ id: 'MSG1', sender: STUDENT, number: MY_OTHER, linked });

  assert.equal(first.respond, true, 'the first socket answers');
  assert.equal(second.respond, false, 'the second stands down — no duplicate');
  assert.equal(second.reason, 'already-claimed');
});

test('when the owner sends from their own phone, only that phone answers', () => {
  const linked = [MY_NUMBER, MY_OTHER];
  // The message is seen by both sockets. Only the one whose number sent it replies.
  const fromSending = dedupe.claimResponder({ id: 'MSG2', sender: MY_NUMBER, number: MY_NUMBER, linked });
  const fromOther = dedupe.claimResponder({ id: 'MSG2', sender: MY_NUMBER, number: MY_OTHER, linked });

  assert.equal(fromSending.respond, true);
  assert.equal(fromOther.respond, false);
  assert.equal(fromOther.reason, 'sender-handled-it');
});

test('the sending-phone rule wins even if the other socket sees the message first', () => {
  const linked = [MY_NUMBER, MY_OTHER];
  // Order is reversed relative to the previous test: the non-sending socket is
  // asked first. It must still decline, because the rule is deterministic and
  // does not depend on who arrived first.
  const fromOther = dedupe.claimResponder({ id: 'MSG3', sender: MY_NUMBER, number: MY_OTHER, linked });
  const fromSending = dedupe.claimResponder({ id: 'MSG3', sender: MY_NUMBER, number: MY_NUMBER, linked });

  assert.equal(fromOther.respond, false, 'the socket that did not send must stay quiet');
  assert.equal(fromSending.respond, true, 'the sending socket answers regardless of order');
});

test('two different messages are each answered once', () => {
  const linked = [MY_NUMBER, MY_OTHER];
  assert.equal(dedupe.claimResponder({ id: 'A', sender: STUDENT, number: MY_NUMBER, linked }).respond, true);
  assert.equal(dedupe.claimResponder({ id: 'B', sender: STUDENT, number: MY_OTHER, linked }).respond, true);
});

/* ── our own replies must not be re-executed ────────────────────────────── */

test('a reply we sent is recognised when it echoes back on another socket', () => {
  dedupe.rememberSend('OUT1');
  assert.equal(dedupe.isOwnSend('OUT1'), true, 'our own reply must be dropped on the way in');
  assert.equal(dedupe.isOwnSend('SOMETHING-ELSE'), false);
});

test('an unknown id is never treated as an echo', () => {
  assert.equal(dedupe.isOwnSend('NEVER-SENT'), false);
  assert.equal(dedupe.isOwnSend(undefined), false);
});
