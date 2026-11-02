'use strict';

/**
 * test/commands.test.js — Phase 4E: every offline command, driven through the
 * REAL gateway (registry → router → runner → child) with the fake socket.
 *
 * The router contract is:
 *   router.handle({ number, sock, message }) -> { handled, ok, reason, ... }
 * and the fake socket records everything in sock.__sent.
 *
 * Network commands are not attempted here; scripts/check-all.js covers their
 * offline stages and marks them ❌ when the provider cannot be reached.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const registry = require(path.join(ROOT, 'gateway/registry'));
const router = require(path.join(ROOT, 'gateway/router'));
const fakesock = require(path.join(ROOT, 'gateway/fakesock'));
const store = require(path.join(ROOT, 'gateway/users/store'));
const status = require(path.join(ROOT, 'gateway/status'));
const usage = require(path.join(ROOT, 'gateway/users/usage'));
const admin = require(path.join(ROOT, 'gateway/admin'));
const { paths } = require(path.join(ROOT, 'lib/paths'));

// This bot is a SELF-bot, exactly like the old one: guard 1 accepts only
// messages whose fromMe is true, and in a DM the chat jid is the linked number.
// So the actor is always the linked number itself. The realistic deployment is
// that the linked number IS the owner's own number, which is what NUMBER below
// models. OTHER is a second linked account whose record says "user": it proves a
// non-owner gets refused and can be put into maintenance.
const NUMBER = '265900000201';        // linked, and the global owner
const OWNER = NUMBER;
const OTHER = '265900000202';         // a second linked account, plain user

let sock;

function texts() {
  return sock.__sent.map((m) => m.content?.text).filter(Boolean).join('\n');
}

function reset() {
  sock.__sent.length = 0;
}

async function send(body, { sender = OWNER, number = NUMBER } = {}) {
  // Clear the cooldown before every call. These tests are about what a command
  // does, not about pacing; cooldown is proven separately in guards.test.js.
  // Without this, two consecutive .users calls hit the real 2s cooldown.
  usage._resetAll();
  const message = fakesock.buildMessage({ body, sender, chat: `${number}@s.whatsapp.net` });
  return router.handle({ number, sock, message });
}

test.before(() => {
  store.writeOwner(OWNER);
  store.ensureNumber(NUMBER);
  const loaded = registry.load({ markStatus: false });
  assert.equal(loaded.failed, 0, `registry failed to load: ${JSON.stringify(loaded.errors)}`);
  assert.equal(loaded.loaded, 22, `expected 22 commands, got ${loaded.loaded}`);
  assert.ok(typeof fakesock.createFakeSocket === 'function', 'the fake socket harness must exist');
});

test.beforeEach(() => {
  usage._resetAll();
  // Clean slate: no toggles, no maintenance, no access restriction, open board.
  fs.rmSync(paths.disabled, { force: true });
  status._reset();
  for (const number of [NUMBER, OTHER]) {
    // Wipe the member list FIRST, then restore the baseline settings. Doing it
    // the other way round deletes the settings that were just written.
    fs.rmSync(path.join(paths.numbers, number, 'users.json'), { force: true });
    fs.rmSync(path.join(paths.numbers, number, 'users.json.bak'), { force: true });
    store.ensureNumber(number);
    store.setMaintenance(number, false);
    store.setAccessMode(number, 'open');
  }
  // OTHER is a linked account that is not the owner: a plain user.
  store.addUser(OTHER, OTHER, { role: 'user' });
  sock = fakesock.createFakeSocket();
});

/* ── the basics ──────────────────────────────────────────────────────────── */

test('.ping replies with the old wording', async () => {
  const outcome = await send('.ping');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.match(texts(), /pong/i, `replies were: ${JSON.stringify(sock.__sent.map((m) => m.content))}`);
});

test('.menu lists the commands and marks a broken one', async () => {
  await send('.menu');
  const text = texts();
  assert.match(text, /ping/);
  assert.match(text, /paper/);

  // Record a real failure the way check-all does, then look at the menu again.
  status.markBroken('sticker', 'ffmpeg exited 1', { source: 'check' });
  try {
    reset();
    await send('.menu');
    const after = texts();
    assert.ok(/sticker/.test(after), 'the broken command must still be listed');
    assert.ok(/⚠️|❌|⛔/.test(after), 'the menu must carry a visible warning marker for a broken command');
  } finally {
    status.markOk('sticker');
  }
});

test('.status reports the board', async () => {
  const outcome = await send('.status');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(sock.__sent.length > 0, 'status must reply with something');
});

/* ── the users command, end to end through the gateway ───────────────────── */

test('.users add / list / ban / unban work through the real command', async () => {
  let outcome = await send('.users add 265900000211');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(store.getUser(NUMBER, '265900000211').role, 'user');

  reset();
  outcome = await send('.users list');
  assert.equal(outcome.ok, true);
  assert.match(texts(), /265900000211/);

  reset();
  await send('.users ban 265900000211');
  assert.equal(store.getUser(NUMBER, '265900000211').role, 'banned');

  reset();
  await send('.users unban 265900000211');
  assert.equal(store.getUser(NUMBER, '265900000211').role, 'user');
  store.removeUser(NUMBER, '265900000211');
});

test('.users refuses a malformed number instead of storing it', async () => {
  await send('.users add not-a-number');
  const text = texts();
  assert.match(text, /valid|number/i, `expected a clear refusal, got: ${text}`);
  assert.equal(store.getUser(NUMBER, 'not-a-number'), null, 'nothing may be stored');
});

test('.users is refused for a linked number that is not the owner', async () => {
  const outcome = await send('.users list', { number: OTHER });
  assert.match(texts(), /restricted/i, 'a plain user must be told the command is restricted');
  // A guard refusal reports refused:true and must NOT carry an ok result; the
  // command itself never ran.
  assert.equal(outcome.refused, true, JSON.stringify(outcome));
  assert.notEqual(outcome.ok, true, 'a refused command must not report success');
  assert.equal(outcome.command, undefined, 'the command must not have been dispatched');
});

/* ── toggles ─────────────────────────────────────────────────────────────── */

test('.toggle disables a command, the router refuses it, then enabling restores it', async () => {
  await send('.toggle ping');   // .toggle <command> flips it
  assert.equal(store.readSettings(NUMBER).maintenance, false);
  assert.equal(status.isDisabled('ping'), true, `board was ${JSON.stringify(status.snapshot().ping)}`);

  reset();
  await send('.ping');
  assert.match(texts(), /disabled/i, 'a disabled command must say so, not pretend to run');

  reset();
  await send('.toggle ping');
  assert.equal(status.isDisabled('ping'), false);

  reset();
  await send('.ping');
  assert.match(texts(), /pong/i, 'after enabling, ping must work again');
});

test('.botmanage maintenance shuts out a plain linked number and spares the owner', async () => {
  // The owner turns maintenance on for their own number; the command works.
  await send('.botmanage maintenance on');
  assert.equal(store.readSettings(NUMBER).maintenance, true);
  reset();
  await send('.ping');
  assert.match(texts(), /pong/i, 'the owner must still be served during maintenance');

  // A second linked number that is a plain user, in maintenance, is refused.
  store.setMaintenance(OTHER, true);
  reset();
  await send('.ping', { number: OTHER });
  assert.match(texts(), /maintenance/i, 'a non-owner must be told about maintenance');

  store.setMaintenance(OTHER, false);
  await send('.botmanage maintenance off');
});

/* ── static replies ──────────────────────────────────────────────────────── */

test('.debrid and .providers keep their wording', async () => {
  await send('.debrid');
  assert.ok(texts().length > 20, 'debrid must reply with its text');

  reset();
  await send('.providers');
  assert.ok(texts().length > 20, 'providers must reply with its list');
});

test('.sessions reports something', async () => {
  const outcome = await send('.sessions');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(sock.__sent.length > 0);
});

/* ── unknown input ───────────────────────────────────────────────────────── */

test('an unknown command produces no reply at all', async () => {
  const outcome = await send('.nosuchthing');
  assert.equal(outcome.handled, false);
  assert.equal(outcome.reason, 'unknown-command');
  assert.equal(sock.__sent.length, 0, 'an unknown command must not send a message');
});

test('a plain chat message (no prefix) is ignored', async () => {
  const outcome = await send('hello there');
  assert.equal(outcome.reason, 'no-prefix');
  assert.equal(sock.__sent.length, 0);
});

test('a message that is not from the linked account is ignored', async () => {
  const message = fakesock.buildMessage({ body: '.ping', fromMe: false, sender: OWNER, chat: `${NUMBER}@s.whatsapp.net` });
  const outcome = await router.handle({ number: NUMBER, sock, message });
  assert.equal(outcome.reason, 'not-from-me');
  assert.equal(sock.__sent.length, 0);
});
