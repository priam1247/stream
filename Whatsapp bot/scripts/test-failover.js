'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFailoverLease } = require('../utils/failoverLease');

function fixture() {
  let mono = 1_000; let wall = 50_000;
  const changes = [];
  const lease = createFailoverLease('xs', {
    instance: 'a'.repeat(32), monotonicNow: () => mono, wallNow: () => wall,
    onChange: (state) => changes.push(state),
  });
  return { lease, changes, advance(ms) { mono += ms; wall += ms; }, jumpWall(ms) { wall += ms; } };
}

test('a node starts fenced and stops before the shared lease can expire', () => {
  const fx = fixture();
  const request = fx.lease.startRequest();
  assert.equal(fx.lease.canServe(), false);
  fx.advance(2_000);
  assert.equal(fx.lease.accept({ granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }, request), true);
  assert.equal(fx.lease.canServe(), true);
  assert.equal(fx.lease.report().epoch, 1);
  fx.advance(25_999);
  assert.equal(fx.lease.canServe(), true);
  fx.advance(1);
  assert.equal(fx.lease.canServe(), false);
  assert.deepEqual(fx.changes, [true, false]);
});

test('slow, denied, malformed or wrong-node grants cannot activate a node', () => {
  const fx = fixture();
  let req = fx.lease.startRequest();
  fx.advance(28_001);
  assert.equal(fx.lease.accept({ granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }, req), false);
  req = fx.lease.startRequest();
  assert.equal(fx.lease.accept({ granted: true, role: 'botkeep', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }, req), false);
  assert.equal(fx.lease.accept({ granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 90_000 }, req), false);
  assert.equal(fx.lease.accept({ granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }, req), true);
  assert.equal(fx.lease.accept({ granted: false }, fx.lease.startRequest()), false);
  assert.equal(fx.lease.canServe(), false);
});

test('wall-clock jumps and explicit revocation fail closed; standalone stays unchanged', () => {
  const fx = fixture();
  const req = fx.lease.startRequest();
  fx.lease.accept({ granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 }, req);
  fx.jumpWall(30_000);
  assert.equal(fx.lease.canServe(), false);
  assert.throws(() => createFailoverLease('wrong'), /role/i);
  assert.throws(() => createFailoverLease('xs', { instance: 'bad' }), /instance/i);
});

test('failover is opt-in and requires private sync, HTTPS and separate standby recovery', () => {
  const { getFailoverRole } = require('../utils/failoverConfig');
  assert.equal(getFailoverRole({}, {}), null);
  assert.throws(() => getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'backup' }, {}), /role/i);
  assert.throws(() => getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'xs' }, { dashboardUrl: 'https://dashboard.example' }), /sync/i);
  assert.throws(() => getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'xs' }, { dashboardUrl: 'http://dashboard.example', syncToken: 'test' }), /https/i);
  assert.throws(() => getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'botkeep', SESSION_BACKUP_KEY: 'secret' }, { dashboardUrl: 'https://dashboard.example', syncToken: 'test' }), /recovery/i);
  assert.equal(getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'xs' }, { dashboardUrl: 'https://dashboard.example', syncToken: 'test' }), 'xs');
  assert.equal(getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'botkeep' }, { dashboardUrl: 'https://dashboard.example', syncToken: 'test' }), 'botkeep');
  const xsUuid = '381c9516-ac72-4b42-a4e3-e16bb7f9f4a0';
  const admin = { dashboardUrl: 'https://dashboard.example', syncToken: 'test' };
  assert.equal(getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'xs', SERVER_UUID: xsUuid }, admin), 'xs');
  assert.throws(() => getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'botkeep', SERVER_UUID: xsUuid }, admin), /does not match/i);
  assert.throws(() => getFailoverRole({ WHATSAPP_FAILOVER_ROLE: 'xs', SERVER_UUID: 'another-server' }, admin), /does not match/i);
});

test('failover mode never sends a host power request using another server’s panel credentials', async () => {
  const { panelRestart } = require('../utils/panelClient');
  let calls = 0;
  const result = await panelRestart({ env: { WHATSAPP_FAILOVER_ROLE: 'botkeep', PANEL_URL: 'https://panel.xsystemshosting.com', PANEL_SERVER_ID: '381c9516', PANEL_API_KEY: 'not-a-real-key' }, fetchImpl: async () => { calls++; return { ok: true, status: 204 }; } });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('the actual hosting server UUID takes precedence over a copied panel server ID', () => {
  const { getPanelConfig } = require('../utils/panelClient');
  const config = getPanelConfig({ PANEL_SERVER_ID: 'old-botkeep', SERVER_UUID: '381c9516-ac72-4b42-a4e3-e16bb7f9f4a0' });
  assert.deepEqual(config.ids, ['381c9516', '381c9516-ac72-4b42-a4e3-e16bb7f9f4a0']);
});

test('device fingerprints use only public identity and detect copied session credentials', () => {
  const { fingerprintDevice } = require('../utils/failoverLease');
  const one = { registered: true, signedIdentityKey: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 9) } };
  const copied = { registered: true, signedIdentityKey: { public: Buffer.alloc(32, 1), private: Buffer.alloc(32, 7) } };
  const another = { registered: true, signedIdentityKey: { public: Buffer.alloc(32, 2) } };
  const fingerprint = fingerprintDevice(one);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, fingerprintDevice(copied));
  assert.notEqual(fingerprint, fingerprintDevice(another));
  assert.equal(fingerprintDevice({ registered: false }), null);
  assert.equal(fingerprintDevice({ registered: true, signedIdentityKey: { public: Buffer.alloc(2) } }), null);
});

test('the known XS server gets the dashboard origin by default without changing other hosts', () => {
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const configPath = path.resolve(__dirname, '../config.js');
  const run = (uuid) => spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(configPath)}).admin.dashboardUrl)`], {
    cwd: os.tmpdir(), env: { PATH: process.env.PATH, SERVER_UUID: uuid }, encoding: 'utf8',
  });
  const xs = run('381c9516-ac72-4b42-a4e3-e16bb7f9f4a0');
  const backup = run('another-server');
  assert.equal(xs.status, 0); assert.equal(xs.stdout, 'https://dashboard-ij71.vercel.app');
  assert.equal(backup.status, 0); assert.equal(backup.stdout, '');
});
