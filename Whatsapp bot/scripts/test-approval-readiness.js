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
const access = require(path.join(ROOT, 'utils/accessControl'));
const { applyWhitelistSnapshot } = require(path.join(ROOT, 'utils/dashboardSync'));
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
    { number: '15550001111', approval: 'pending', enabled: true, pairAllowed: true },
    { number: '15550002222', approval: 'rejected', enabled: true, pairAllowed: true },
    { number: '15550003333', approval: 'approved', enabled: true, pairAllowed: false },
    { number: '15550004444', label: 'missing enabled status' },
  ], file);
  const users = access.readWL({ filePath: file, force: true }).users;
  assert.equal(users[0].enabled, false); assert.equal(users[0].pairAllowed, true);
  assert.equal(users[1].enabled, false); assert.equal(users[1].pairAllowed, false);
  assert.equal(users[2].enabled, true); assert.equal(users[2].pairAllowed, false);
  assert.equal(users[3].enabled, false);
});
