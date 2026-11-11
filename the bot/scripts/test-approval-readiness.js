'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');
clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-approval-'));
const ROOT = createBotFixture(TMP);
process.chdir(TMP);
const access = require(path.join(ROOT, 'gateway/users/access'));
const { applyWhitelistSnapshot } = require(path.join(ROOT, 'gateway/dashboard/sync'));
const file = path.join(TMP, 'snapshot.json');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('approval fails closed for pending, rejected and malformed records while keeping existing members', () => {
  assert.equal(access.isApprovedUser({ number: '10000001' }), true); // legacy local record
  assert.equal(access.isApprovedUser({ approval: 'approved', enabled: true }), true);
  assert.equal(access.isApprovedUser({ approval: 'approved', enabled: false }), false);
  assert.equal(access.isApprovedUser({ approval: 'pending', enabled: true, pairAllowed: true }), false);
  assert.equal(access.isApprovedUser({ approval: 'rejected', enabled: true }), false);
  assert.equal(access.isApprovedUser({ approval: 'unknown', enabled: true }), false);
  assert.equal(access.canPairUser({ approval: 'pending', enabled: false, pairAllowed: true }), true);
  assert.equal(access.canPairUser({ approval: 'pending', enabled: false, pairAllowed: false }), false);
  assert.equal(access.canPairUser({ approval: 'rejected', enabled: true, pairAllowed: true }), false);
});

test('dashboard snapshots preserve pending pairing but do not enable it or an incomplete entry', () => {
  applyWhitelistSnapshot([
    { number: '15550001111', approval: 'pending', enabled: true, pairAllowed: true, claimId: 'pending-claim', addedBy: 'member@example.com' },
    { number: '15550002222', approval: 'rejected', enabled: true, pairAllowed: true, claimId: 'rejected-claim', addedBy: 'member@example.com' },
    { number: '15550003333', approval: 'approved', enabled: true, pairAllowed: false, claimId: 'approved-claim', addedBy: 'member@example.com' },
    { number: '15550004444', label: 'missing enabled status', claimId: 'incomplete-claim', addedBy: 'member@example.com' },
  ], file);
  const users = access.readWL({ filePath: file, force: true }).users;
  assert.equal(users[0].enabled, false); assert.equal(users[0].pairAllowed, true);
  assert.equal(users[1].enabled, false); assert.equal(users[1].pairAllowed, false);
  assert.equal(users[2].enabled, true); assert.equal(users[2].pairAllowed, false);
  assert.equal(users[3].enabled, false);
  assert.equal(users.length, 4);

  // A full empty portal snapshot removes local `.allow` records too.
  access.writeWL({ users: [{ number: '15550005555', enabled: true, label: 'Added via WhatsApp .allow' }] }, { filePath: file });
  applyWhitelistSnapshot([], file);
  assert.deepEqual(access.readWL({ filePath: file, force: true }).users, []);
});
