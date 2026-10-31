'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startDashboardSync } = require('../utils/dashboardSync');

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
    users: [{ number: '15550001111', enabled: true }, { number: '15550002222', enabled: true }],
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
    users: [{ number: '15550001111', enabled: false }, { number: '15550003333', enabled: true }],
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
    commandPolicy: { version: () => '', apply: () => {} },
    onPermissionsReady: () => { ready++; },
    fetchImpl: async () => ({ ok: true, json: async () => ++calls === 1
      ? { whitelistChanged: true, whitelistVersion: '1234567890abcdef', users: [], commands: [] }
      : { whitelistChanged: false, whitelistVersion: '1234567890abcdef', disabledMemberCommands: [], commandPolicyVersion: '0123456789abcdef', commands: [] } }),
  });
  t.after(() => sync.stop());
  await sync.syncNow(); assert.equal(ready, 0);
  await sync.syncNow(); assert.equal(ready, 1);
});

test('only a current failover lease can execute bridge commands, and standby still receives permissions', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-failover-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = createFailoverLease('botkeep', { instance: 'b'.repeat(32) });
  let calls = 0;
  const bodies = [];
  let pairs = 0;
  const sync = startDashboardSync({
    dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true,
    wlFile: path.join(root, 'whitelist.json'), failover: lease,
    getStatus: () => ({ connected: true }),
    requestPairing: async () => { pairs++; return { code: 'SAFE', issuedAt: Date.now() }; },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      calls++;
      return { ok: true, json: async () => ({
        failover: calls === 2 ? { granted: true, role: 'botkeep', instance: 'b'.repeat(32), epoch: 2, ttlMs: 30_000 } : { granted: false },
        whitelistChanged: calls === 1, whitelistVersion: '0123456789abcdef',
        users: [{ number: '15550001111', enabled: true }],
        commands: [{ id: `pair-${calls}`, type: 'pair', payload: { number: '15550001111' }, expiresAt: Date.now() + 60_000 }],
      }) };
    },
  });
  t.after(() => sync.stop());
  await sync.syncNow(); await flush();
  assert.equal(lease.canServe(), false);
  assert.equal(pairs, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'whitelist.json'))).users.length, 1);
  await sync.syncNow(); await flush();
  assert.equal(lease.canServe(), true);
  assert.equal(pairs, 1);
  assert.equal(bodies[1].failover.epoch, 0);
  await sync.syncNow(); await flush();
  assert.equal(bodies[2].failover.epoch, 2);
  assert.equal(lease.canServe(), false);
  assert.equal(pairs, 1);
});

test('a slow command that finishes after lease revocation cannot report an old pairing code', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-failover-late-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = createFailoverLease('xs', { instance: 'a'.repeat(32) });
  let complete;
  const wait = new Promise((resolve) => { complete = resolve; });
  const bodies = [];
  let calls = 0;
  const sync = startDashboardSync({
    dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true,
    wlFile: path.join(root, 'whitelist.json'), failover: lease, getStatus: () => ({ connected: true }),
    requestPairing: () => wait,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      calls++;
      return { ok: true, json: async () => ({
        failover: calls === 1 ? { granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 } : { granted: false },
        whitelistChanged: calls === 1, whitelistVersion: '0123456789abcdef', users: [{ number: '15550001111', enabled: true }],
        commands: calls === 1 ? [{ id: 'slow', type: 'pair', payload: { number: '15550001111' }, expiresAt: Date.now() + 60_000 }] : [],
      }) };
    },
  });
  t.after(() => sync.stop());
  await sync.syncNow();
  await sync.syncNow();
  complete({ code: 'MUST-NOT-REPORT', issuedAt: Date.now() });
  await flush();
  await sync.syncNow();
  assert.deepEqual(bodies[2].completedResults, []);
});

test('the bridge supplies an epoch-bound ownership check to pairing and unlink operations', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-epoch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = createFailoverLease('xs', { instance: 'a'.repeat(32) });
  let pairGuard, unlinkGuard, calls = 0;
  const sync = startDashboardSync({
    dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true,
    wlFile: path.join(root, 'whitelist.json'), failover: lease,
    requestPairing: async (_number, options) => { pairGuard = options?.canExecute; return { code: 'SAFE' }; },
    unlinkAccount: async (_number, _session, options) => { unlinkGuard = options?.canExecute; return {}; },
    fetchImpl: async () => ({ ok: true, json: async () => ({
      failover: ++calls === 1 ? { granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }
        : { granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 2, ttlMs: 30_000 },
      whitelistChanged: calls === 1, whitelistVersion: '0123456789abcdef',
      users: [{ number: '15550001111', enabled: true, addedBy: 'member@example.com', claimId: 'claim-one' }],
      commands: calls === 1 ? [
        { id: 'pair', type: 'pair', payload: { number: '15550001111' } },
        { id: 'unlink', type: 'unlink', payload: { number: '15550001111', sessionId: 'b'.repeat(24), owner: 'member@example.com', claimKey: 'claim-one' } },
      ] : [],
    }) }),
  });
  t.after(() => sync.stop());
  await sync.syncNow(); await flush();
  assert.equal(typeof pairGuard, 'function');
  assert.equal(typeof unlinkGuard, 'function');
  assert.equal(pairGuard(), true);
  assert.equal(unlinkGuard(), true);
  await sync.syncNow();
  assert.equal(lease.canServe(), true);
  assert.equal(pairGuard(), false, 'a new epoch must not authorize an old pairing command');
  assert.equal(unlinkGuard(), false, 'a new epoch must not authorize an old unlink command');
});

test('failover retries transient errors within the lease and bounds poll and request times', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = createFailoverLease('xs', { instance: 'a'.repeat(32) });
  const scheduled = [], timeouts = [];
  let calls = 0;
  const sync = startDashboardSync({
    dashboardUrl: 'https://dashboard.example', token: 'test-token', failover: lease, wlFile: path.join(root, 'whitelist.json'),
    setTimer: (_callback, ms) => { scheduled.push(ms); return { unref() {} }; },
    clearTimer: () => {}, timeoutSignal: (ms) => { timeouts.push(ms); return new AbortController().signal; },
    fetchImpl: async () => {
      if (++calls === 1) throw new Error('temporary timeout');
      if (calls === 2) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ nextPollMs: 60_000, failover: { granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }, commands: [] }) };
    },
  });
  t.after(() => sync.stop());
  assert.equal(scheduled.at(-1), 250);
  await sync.syncNow(); assert.equal(scheduled.at(-1), 3_000);
  await sync.syncNow(); assert.equal(scheduled.at(-1), 3_000);
  await sync.syncNow(); assert.equal(scheduled.at(-1), 5_000);
  assert.deepEqual(timeouts, [5_000, 5_000, 5_000]);
});

test('heartbeat preserves aggregate status but sends the primary number in the failover identity', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-primary-number-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let body;
  const sync = startDashboardSync({ dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true,
    wlFile: path.join(root, 'whitelist.json'), failover: createFailoverLease('xs'),
    getStatus: () => ({ connected: true, botNumber: '15550001111', primaryConnected: false, primaryNumber: '15550009999' }),
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ failover: { granted: false } }) }; },
  });
  t.after(() => sync.stop());
  await sync.syncNow();
  assert.equal(body.botNumber, '15550001111');
  assert.equal(body.failover.accountNumber, '15550009999');
  assert.equal(body.failover.primaryConnected, false);
});

test('one five-second timeout and the short retry leave time to renew an active lease', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-one-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 0, calls = 0, delayMs = 0;
  const lease = createFailoverLease('xs', { instance: 'a'.repeat(32), monotonicNow: () => clock, wallNow: () => 1_000_000 + clock });
  const grant = { granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 };
  assert.equal(lease.accept(grant, lease.startRequest()), true);
  const sync = startDashboardSync({ dashboardUrl: 'https://dashboard.example', token: 'test-token', failover: lease,
    wlFile: path.join(root, 'whitelist.json'), setTimer: (_fn, ms) => { delayMs = ms; return { unref() {} }; },
    clearTimer: () => {}, timeoutSignal: () => new AbortController().signal,
    fetchImpl: async () => { if (++calls === 1) { clock += 5_000; throw new Error('timeout'); }
      return { ok: true, json: async () => ({ failover: grant, commands: [] }) }; },
  });
  t.after(() => sync.stop());
  clock = 5_000; // ordinary next poll after the previous grant
  await sync.syncNow();
  assert.equal(delayMs, 3_000);
  assert.equal(lease.canServe(), true);
  clock += delayMs;
  const result = await sync.syncNow();
  assert.equal(result.ok, true);
  assert.equal(lease.canServe(), true);
  clock = 29_000; // past the original lease's deadline, but before the renewal's
  assert.equal(lease.canServe(), true);
});
