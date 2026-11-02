'use strict';

/**
 * test/users.test.js — Phase 4C: the users mechanism.
 *
 * add, remove, ban, unban, role, block, list, info, audit log, backup, and the
 * per-number isolation that the whole multi-number design exists for.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'gateway/users/store'));
const admin = require(path.join(ROOT, 'gateway/admin'));
const registry = require(path.join(ROOT, 'gateway/registry'));
const { paths, usersFile } = require(path.join(ROOT, 'lib/paths'));

const A = '265900000101';
const B = '265900000102';
const OWNER = '265900000109';
const RIVAL_OWNER = '265900000110';
const USER = '265900000111';

function reset(number) {
  fs.rmSync(path.join(paths.numbers, number), { recursive: true, force: true });
  store.ensureNumber(number);
}

test.before(() => {
  store.writeOwner(OWNER);
  // admin.apply checks command names against the registry (block/toggle/reload),
  // so the registry has to be populated the way boot does it.
  registry.load({ markStatus: false });
});

test.beforeEach(() => {
  reset(A);
  reset(B);
});

/* ── the store is the only writer ────────────────────────────────────────── */

test('users.json has exactly one writer in the codebase', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'storage', 'sessions', 'logs'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full);
      if (rel.startsWith('test')) continue;
      const source = fs.readFileSync(full, 'utf8');
      // Writing is the thing being forbidden; reading the filename is fine.
      if (/writeJsonAtomic\s*\(\s*usersFile|writeFileSync\s*\(\s*usersFile/.test(source)) {
        offenders.push(rel);
      }
    }
  };
  walk(ROOT);

  assert.deepEqual(offenders, ['gateway/users/store.js'], `users.json written from: ${offenders.join(', ')}`);
});

test('a command cannot reach the store: the admin door refuses out-of-band actions', async () => {
  // gateway/admin.js re-checks the actor, so a command that calls it cannot
  // escalate. A plain user is refused even if the command's own role is admin.
  await assert.rejects(
    async () => admin.apply({ number: A, sender: USER, request: { action: 'add', target: '265900000199' } }),
    /needs role "admin"/,
  );
});

test('only the owner may change an existing admin', async () => {
  const actorIsAdmin = '265900000112';
  store.addUser(A, actorIsAdmin, { role: 'admin' });

  // The admin may promote a plain user to admin.
  await admin.apply({ number: A, sender: actorIsAdmin, request: { action: 'role', target: '265900000113', extra: 'admin' } });
  assert.equal(store.getUser(A, '265900000113').role, 'admin');

  // The same admin may not demote another admin: that is owner-only.
  await assert.rejects(
    async () => admin.apply({ number: A, sender: actorIsAdmin, request: { action: 'role', target: '265900000113', extra: 'user' } }),
    /needs role "owner"/,
  );

  // The owner can.
  await admin.apply({ number: A, sender: OWNER, request: { action: 'role', target: '265900000113', extra: 'user' } });
  assert.equal(store.getUser(A, '265900000113').role, 'user');
});

test('nobody can promote to owner through the admin door', async () => {
  await assert.rejects(
    async () => admin.apply({ number: A, sender: OWNER, request: { action: 'role', target: '265900000113', extra: 'owner' } }),
    /role must be "admin" or "user"/,
  );
});

/* ── CRUD through the real door ──────────────────────────────────────────── */

test('add, list, info, remove round-trip', async () => {
  const added = await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  assert.match(added.message, /Added/);
  assert.equal(store.getUser(A, USER).role, 'user');

  const list = await admin.apply({ number: A, sender: OWNER, request: { action: 'list' } });
  assert.equal(list.users.length, 1);

  const info = await admin.apply({ number: A, sender: OWNER, request: { action: 'info', target: USER } });
  assert.equal(info.user.number, USER);

  const removed = await admin.apply({ number: A, sender: OWNER, request: { action: 'remove', target: USER } });
  assert.match(removed.message, /Removed/);
  assert.equal(store.getUser(A, USER), null);
});

test('ban, unban and role change are reflected in the record and the audit log', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  await admin.apply({ number: A, sender: OWNER, request: { action: 'ban', target: USER } });
  assert.equal(store.getUser(A, USER).role, 'banned');
  assert.equal(store.getUser(A, USER).status, 'banned');

  await admin.apply({ number: A, sender: OWNER, request: { action: 'unban', target: USER } });
  assert.equal(store.getUser(A, USER).role, 'user');

  await admin.apply({ number: A, sender: OWNER, request: { action: 'role', target: USER, extra: 'admin' } });
  assert.equal(store.getUser(A, USER).role, 'admin');

  const log = fs.readFileSync(paths.usersLog, 'utf8');
  assert.match(log, /user added/);
  assert.match(log, /user banned/);
  assert.match(log, /user unbanned/);
  assert.match(log, /role -> admin/);
});

test('a user record carries everything the spec asks for', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  const user = store.getUser(A, USER);
  for (const field of ['number', 'name', 'role', 'status', 'joinedAt', 'lastSeen', 'blockedCommands', 'usage']) {
    assert.ok(field in user, `record is missing "${field}"`);
  }
  assert.ok(Array.isArray(user.blockedCommands));
  assert.equal(user.blockedCommands.length, 0);
});

test('blocking a command records it and leaves other commands alone', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  await admin.apply({ number: A, sender: OWNER, request: { action: 'block', target: USER, extra: 'ping' } });
  assert.deepEqual(store.getUser(A, USER).blockedCommands, ['ping']);

  await admin.apply({ number: A, sender: OWNER, request: { action: 'unblock', target: USER, extra: 'ping' } });
  assert.deepEqual(store.getUser(A, USER).blockedCommands, []);
});

test('blocking an unknown command is refused, not silently stored', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  await assert.rejects(
    () => admin.apply({ number: A, sender: OWNER, request: { action: 'block', target: USER, extra: 'nosuchcommand' } }),
    /no command named/,
  );
});

/* ── backups ─────────────────────────────────────────────────────────────── */

test('every write leaves a last-good .bak copy behind', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  const backup = `${usersFile(A)}.bak`;
  assert.ok(fs.existsSync(backup), 'the .bak copy must exist after a write');

  // The backup must be valid JSON with the same content.
  const parsed = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.equal(parsed.users.length, 1);
});

test('a corrupt users.json is refused, never treated as an empty list', () => {
  fs.writeFileSync(usersFile(A), '{ this is not json');
  fs.rmSync(`${usersFile(A)}.bak`, { force: true });
  assert.throws(() => store.readUsers(A), /corrupt/);
});

test('a corrupt users.json recovers from .bak instead of losing members', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  fs.writeFileSync(usersFile(A), '{ broken');
  const recovered = store.readUsers(A);
  assert.equal(recovered.users.length, 1, '.bak must be used when the primary is unreadable');
});

/* ── per-number isolation (the part that matters) ────────────────────────── */

test('a ban on number A does not affect number B', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  await admin.apply({ number: B, sender: OWNER, request: { action: 'add', target: USER } });

  await admin.apply({ number: A, sender: OWNER, request: { action: 'ban', target: USER } });

  assert.equal(store.getUser(A, USER).role, 'banned', 'A must be banned');
  assert.equal(store.getUser(B, USER).role, 'user', 'B must be untouched');
});

test('removing a user on A leaves them on B', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  await admin.apply({ number: B, sender: OWNER, request: { action: 'add', target: USER } });
  await admin.apply({ number: A, sender: OWNER, request: { action: 'remove', target: USER } });

  assert.equal(store.getUser(A, USER), null);
  assert.notEqual(store.getUser(B, USER), null);
});

test('access mode is per number', () => {
  store.setAccessMode(A, 'whitelist');
  assert.equal(store.readSettings(A).accessMode, 'whitelist');
  assert.equal(store.readSettings(B).accessMode, 'open', 'B must keep its own default');
});

test('maintenance is per number', () => {
  store.setMaintenance(A, true);
  assert.equal(store.readSettings(A).maintenance, true);
  assert.equal(store.readSettings(B).maintenance, false);
});

test('the owner is the same person on every number', () => {
  assert.equal(store.readOwner(), OWNER);
  reset(B);
  assert.equal(store.effectiveRole(B, store.listUsers(B)), null, 'no per-number record for the owner');
  // effectiveRole takes a number; verify the override itself.
  assert.equal(store.effectiveRole(OWNER, []), 'owner');
  assert.equal(store.effectiveRole(RIVAL_OWNER, []), null);
});

test('the numbers on disk match the numbers asked about', async () => {
  await admin.apply({ number: A, sender: OWNER, request: { action: 'add', target: USER } });
  const listed = store.listNumbers();
  assert.ok(listed.includes(A));
  assert.ok(!fs.existsSync(usersFile(B)) || JSON.parse(fs.readFileSync(usersFile(B), 'utf8')).users.length === 0);
});
