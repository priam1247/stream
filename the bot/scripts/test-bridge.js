'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-source-'));
const BOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(BOT, 'scripts', 'test-bridge.js'));
process.chdir(TMP);
botRequire('../lib/telemetry')._resetForTests(null);
const { startDashboardSync } = botRequire('../gateway/dashboard/sync');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, firstResponse, requestPairing, unlinkAccount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wlFile = path.join(root, 'whitelist.json');
  const bodies = [];
  let first = true;
  let notifications = 0;
  const sync = startDashboardSync({
    dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true, wlFile,
    getStatus: () => ({ connected: true, accounts: [{ number: '15550000001', state: 'connected' }] }),
    onWhitelistChanged: () => { notifications++; },
    requestPairing,
    unlinkAccount,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const value = first ? firstResponse : { whitelistChanged: false, commands: [] };
      first = false;
      return { ok: true, json: async () => value };
    },
  });
  t.after(() => sync.stop());
  return { sync, bodies, wlFile, notifications: () => notifications };
}

test('a slow pairing handshake does not block heartbeats or other pairing commands', async (t) => {
  let finishSlow;
  let finishFast;
  const slow = new Promise((resolve) => { finishSlow = resolve; });
  const fast = new Promise((resolve) => { finishFast = resolve; });
  const calls = [];
  const fx = fixture(t, {
    whitelistChanged: true, whitelistVersion: '0123456789abcdef',
    users: [{ number: '15550001111', enabled: true, claimId: 'one', addedBy: 'member@example.com' }, { number: '15550002222', enabled: true, claimId: 'two', addedBy: 'member@example.com' }],
    commands: [
      { id: 'slow', type: 'pair', payload: { number: '15550001111' }, expiresAt: Date.now() + 60_000 },
      { id: 'fast', type: 'pair', payload: { number: '15550002222' }, expiresAt: Date.now() + 60_000 },
    ],
  }, (number) => { calls.push(number); return number.endsWith('1111') ? slow : fast; });

  await fx.sync.syncNow();
  assert.deepEqual(calls, ['15550001111', '15550002222']);
  assert.equal(fx.notifications(), 1);
  await fx.sync.syncNow();
  assert.equal(fx.bodies.length, 2, 'another heartbeat should run while both requests are pending');
  assert.deepEqual(fx.bodies[1].accounts, [{ number: '15550000001', state: 'connected' }]);
  assert.deepEqual(fx.bodies[1].completedResults, []);
  const issuedAt = Date.now();
  finishFast({ code: 'FASTCODE', expiresInSeconds: 60, issuedAt });
  await flush();
  await fx.sync.syncNow();
  assert.deepEqual(fx.bodies[2].completedResults, [{ id: 'fast', ok: true, result: { code: 'FASTCODE', expiresInSeconds: 60, issuedAt } }]);
  finishSlow({ code: 'SLOWCODE', expiresInSeconds: 60, issuedAt });
  await flush();
  await fx.sync.syncNow();
  assert.deepEqual(fx.bodies[3].completedResults.map((r) => r.id), ['slow']);
});

test('revoked, absent and expired queued requests cannot re-enable a number or get a code', async (t) => {
  const calls = [];
  const fx = fixture(t, {
    whitelistChanged: true, whitelistVersion: 'fedcba9876543210',
    users: [{ number: '15550001111', enabled: false, claimId: 'one', addedBy: 'member@example.com' }, { number: '15550003333', enabled: true, claimId: 'three', addedBy: 'member@example.com' }],
    commands: [
      { id: 'disabled', type: 'pair', payload: { number: '15550001111' } },
      { id: 'removed', type: 'pair', payload: { number: '15550002222' } },
      { id: 'expired', type: 'pair', payload: { number: '15550003333' }, expiresAt: Date.now() - 1 },
    ],
  }, (number) => { calls.push(number); return Promise.resolve({ code: 'NEVER' }); });
  await fx.sync.syncNow();
  await flush();
  await fx.sync.syncNow();
  assert.deepEqual(calls, []);
  assert.equal(fx.bodies[1].completedResults.length, 3);
  assert.ok(fx.bodies[1].completedResults.every((r) => !r.ok && !JSON.stringify(r).includes('NEVER')));
  const stored = JSON.parse(fs.readFileSync(fx.wlFile, 'utf8'));
  assert.equal(stored.users.find((u) => u.number === '15550001111').enabled, false);
  assert.equal(stored.users.some((u) => u.number === '15550002222'), false);
});

test('a corrupted local allowlist fails closed without permanently wedging heartbeat sync', async (t) => {
  const fx = fixture(t, { whitelistChanged: false, commands: [] }, async () => ({ code: 'NEVER' }));
  fs.writeFileSync(fx.wlFile, '{corrupt');
  assert.equal((await fx.sync.syncNow()).ok, false);
  assert.equal(fx.bodies.length, 0);
  fs.writeFileSync(fx.wlFile, JSON.stringify({ users: [] }));
  assert.equal((await fx.sync.syncNow()).ok, true);
  assert.equal(fx.bodies.length, 1);
});

test('queued unlink checks the current member owner and exact session generation', async (t) => {
  const calls = [];
  const sessionId = 'a'.repeat(24);
  const fx = fixture(t, {
    whitelistChanged: true, whitelistVersion: '1234567890abcdef',
    users: [{ number: '15550001111', enabled: true, addedBy: 'member@example.com', claimId: 'claim-one' },
      { number: '15550002222', enabled: true, addedBy: 'new-owner@example.com', claimId: 'claim-two' }],
    commands: [
      { id: 'ok', type: 'unlink', payload: { number: '15550001111', sessionId, owner: 'member@example.com', claimKey: 'claim-one' }, expiresAt: Date.now() + 60_000 },
      { id: 'transferred', type: 'unlink', payload: { number: '15550002222', sessionId, owner: 'member@example.com', claimKey: 'claim-two' }, expiresAt: Date.now() + 60_000 },
      { id: 'old-claim', type: 'unlink', payload: { number: '15550001111', sessionId, owner: 'member@example.com', claimKey: 'old-claim' } },
      { id: 'invalid', type: 'unlink', payload: { number: '15550001111', sessionId: 'bad', owner: 'member@example.com' } },
    ],
  }, async () => ({}), async (number, id) => { calls.push([number, id]); return { number, sessionId: id, unlinked: true }; });
  await fx.sync.syncNow();
  await flush();
  await fx.sync.syncNow();
  assert.deepEqual(calls, [['15550001111', sessionId]]);
  const results = fx.bodies[1].completedResults;
  assert.equal(results.find((r) => r.id === 'ok').ok, true);
  assert.equal(results.find((r) => r.id === 'transferred').ok, false);
  assert.equal(results.find((r) => r.id === 'old-claim').ok, false);
  assert.equal(results.find((r) => r.id === 'invalid').ok, false);
});

test('member access waits until this process has both current portal snapshots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-policy-ready-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let ready = 0; let calls = 0;
  const sync = startDashboardSync({
    dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true, wlFile: path.join(root, 'whitelist.json'),
    onPermissionsReady: () => { ready++; },
    fetchImpl: async () => ({ ok: true, json: async () => ++calls === 1
      ? { whitelistChanged: true, whitelistVersion: '1234567890abcdef', users: [], commands: [] }
      : { whitelistChanged: false, whitelistVersion: '1234567890abcdef', commands: [] } }),
  });
  t.after(() => sync.stop());
  await sync.syncNow(); assert.equal(ready, 1);
  await sync.syncNow(); assert.equal(ready, 1);
});

test('the bridge refuses legacy remote power commands', async (t) => {
  const fx = fixture(t, {
    whitelistChanged: true, whitelistVersion: '0123456789abcdef', users: [],
    commands: [{ id: 'old-power', type: 'restart', payload: {} }],
  });
  await fx.sync.syncNow();
  await flush();
  await fx.sync.syncNow();
  assert.deepEqual(fx.bodies[1].completedResults, [{ id: 'old-power', ok: false, error: 'Unsupported command type: restart' }]);
});
