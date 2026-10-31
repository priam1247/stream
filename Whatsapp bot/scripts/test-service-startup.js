'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSessionServices, stopSessionServices, createServiceLifecycle } = require('../utils/serviceStartup');

test('failed session startup cleans up before retry and never starts a bridge', async () => {
  const events = [];
  const failing = { start: async () => { events.push('start'); throw new Error('failed'); }, stop: async () => events.push('stop') };
  await assert.rejects(startSessionServices(failing, async () => events.push('bridge'), async () => events.push('cleanup')), /failed/);
  assert.deepEqual(events, ['start', 'stop', 'cleanup']);
  const next = { start: async () => events.push('retry'), stop: async () => events.push('stop-retry') };
  await startSessionServices(next, async () => events.push('bridge'));
  assert.deepEqual(events, ['start', 'stop', 'cleanup', 'retry', 'bridge']);
});

test('a bridge failure stops already started sessions', async () => {
  const events = [];
  const sessions = { start: async () => events.push('start'), stop: async () => events.push('stop') };
  await assert.rejects(startSessionServices(sessions, async () => { events.push('bridge'); throw new Error('bridge failed'); }), /bridge failed/);
  assert.deepEqual(events, ['start', 'bridge', 'stop']);
});

test('shutdown stops new requests, waits for sessions, and flushes encrypted recovery', async () => {
  const events = []; let release;
  const waitForWrites = new Promise((resolve) => { release = resolve; });
  const resource = {
    sync: { stop: () => events.push('sync') },
    api: { stop: async () => events.push('api') },
    sessions: { stop: async () => { events.push('sessions-start'); await waitForWrites; events.push('sessions-done'); } },
    backup: { stop: async (options) => { assert.deepEqual(options, { flush: true }); events.push('backup'); } },
  };
  const stopping = stopSessionServices(resource);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['sync', 'api', 'sessions-start']);
  release(); await stopping;
  assert.deepEqual(events, ['sync', 'api', 'sessions-start', 'sessions-done', 'backup']);
});

test('shutdown still flushes the backup when another component fails', async () => {
  const events = [];
  await assert.rejects(stopSessionServices({
    sync: { stop: () => { throw new Error('sync failed'); } },
    api: { stop: async () => { throw new Error('api failed'); } },
    sessions: { stop: async () => { events.push('sessions'); throw new Error('sessions failed'); } },
    backup: { stop: async () => events.push('backup') },
  }), AggregateError);
  assert.deepEqual(events, ['sessions', 'backup']);
});

test('a stop during startup closes the resulting service once and suppresses retries', async () => {
  const events = []; let release;
  const startup = new Promise((resolve) => { release = resolve; });
  const lifecycle = createServiceLifecycle({
    start: async () => { events.push('starting'); await startup; return { id: 'service' }; },
    stop: async (service) => { events.push(`stopped:${service.id}`); },
    onError: () => events.push('error'), retryDelayMs: 5,
  });
  lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  const first = lifecycle.shutdown(); const second = lifecycle.shutdown();
  release();
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['starting', 'stopped:service']);
});

test('a failed startup can retry, but a later stop cancels pending retries', async () => {
  let attempts = 0;
  const lifecycle = createServiceLifecycle({
    start: async () => { attempts += 1; throw new Error('offline'); },
    onError: () => {}, retryDelayMs: 10,
  });
  lifecycle.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(attempts >= 2);
  await lifecycle.shutdown();
  const atShutdown = attempts;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(attempts, atShutdown);
});

test('importing cleanup does not take over process signal handling', () => {
  const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
  const id = require.resolve('../utils/cleanup');
  delete require.cache[id];
  require(id);
  assert.equal(process.listenerCount('SIGTERM'), before.term);
  assert.equal(process.listenerCount('SIGINT'), before.int);
});

for (const [signal, failBackup] of [['SIGTERM', false], ['SIGINT', false], ['SIGTERM', true]]) {
  test(`the bot entry point handles ${signal} and flushes session recovery${failBackup ? ' while reporting a failure' : ''}`, async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const root = path.resolve(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-entry-stop-'));
    const marker = path.join(dir, 'events');
    fs.mkdirSync(path.join(dir, 'utils'));
    for (const name of ['serviceStartup.js', 'safeLog.js']) fs.copyFileSync(path.join(root, 'utils', name), path.join(dir, 'utils', name));
    fs.copyFileSync(path.join(root, 'index.js'), path.join(dir, 'index.js'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(dir, 'preload.cjs'), `
      const Module = require('node:module');
      const fs = require('node:fs');
      const mark = (name) => fs.appendFileSync(process.env.TEST_MARKER, name + '\\n');
      const ffmpeg = () => 'ffmpeg'; ffmpeg.works = () => false;
      const logger = () => ({info(){},warn(){},error(){},debug(){}}); logger.banner = () => {};
      const fake = {
        './utils/tempManager': { initializeTempSystem() {} },
        './utils/cleanup': { startCleanup() {}, stopCleanup() { mark('cleanup'); }, cleanupOldFiles() {} },
        './utils/diskGuard': { startDiskGuard() {}, stopDiskGuard() { mark('disk'); } },
        './utils/jobDelivery': { protectPendingFiles() {} },
        'pino': () => ({ info() {} }),
        '@whiskeysockets/baileys': { default() {}, useMultiFileAuthState() {}, DisconnectReason: { loggedOut: 401 }, Browsers: { ubuntu() {} }, fetchLatestWaWebVersion: async () => ({}) },
        'qrcode-terminal': { generate() {} },
        './config': { sessionID: '', sessionName: 'session', prefix: '.', botName: 'Test', admin: { dashboardUrl: 'https://example.invalid', syncToken: 'test', apiEnabled: true, token: 'test', port: 1234 } },
        './handler': { handleMessage() {} },
        './utils/hotReload': { onReload() {} },
        './utils/jid': { isSystemJid() { return false; } },
        './utils/sessionManager': { createSessionManager: () => ({ start: async () => { mark('sessions-start'); }, stop: async () => { mark('sessions-stop-start'); await new Promise((r) => setTimeout(r, 20)); mark('sessions-stop-done'); }, status: () => ({}) }) },
        './utils/accessControl': { readWL: () => ({ users: [] }) },
        './utils/sessionBackup': { createSessionBackup: () => ({ restore: async () => {}, wrapAuth() {}, status: () => ({}), stop: async (opts) => { mark('backup-flush:' + opts?.flush); if (process.env.TEST_FAIL_BACKUP) throw new AggregateError([new Error('snapshot failed', { cause: new Error('storage failure token=secret-shutdown-fixture', { cause: new Error('disk denied') }) })], 'backup flush failed'); } }) },
        './utils/dashboardSync': { startDashboardSync: () => ({ enabled: true, stop() { mark('sync-stop'); if (process.env.TEST_FAIL_BACKUP) throw new Error('closing session token=secret-filter-fixture'); } }), triggerImmediateSync() {} },
        './utils/adminApi': { startAdminApi: () => { setImmediate(() => { process.emit('unhandledRejection', undefined); process.stdout.write('SERVICE_READY\\n'); }); return { stop: async () => { mark('api-stop'); } }; } },
        './utils/logger': logger,
        './utils/youtubedl': { scheduleAutoUpdate() {}, healthCheck: async () => null, startWatchdog() {} },
        './utils/ffmpeg': ffmpeg,
        './utils/nm3u8dl': { ensureInstalled: async () => null },
        './utils/telemetry': { flushNow() { mark('telemetry'); } },
      };
      const original = Module._load;
      Module._load = function (request, parent, isMain) {
        if (parent?.filename.endsWith('/index.js') && Object.hasOwn(fake, request)) return fake[request];
        return original.apply(this, arguments);
      };
      setInterval(() => {}, 10000);
    `);
    const child = spawn(process.execPath, ['--require', path.join(dir, 'preload.cjs'), path.join(dir, 'index.js')], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', TEST_MARKER: marker, ...(failBackup ? { TEST_FAIL_BACKUP: '1' } : {}) },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    let output = ''; let signalled = false;
    child.stdout.on('data', (data) => {
      output += data;
      if (!signalled && output.includes('SERVICE_READY')) { signalled = true; child.kill(signal); }
    });
    child.stderr.on('data', (data) => { output += data; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('isolated bot did not stop in time')); }, 5000);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, exitSignal) => { clearTimeout(timer); resolve({ code, exitSignal }); });
    });
    assert.equal(signalled, true, output);
    assert.deepEqual(result, { code: 0, exitSignal: null });
    assert.doesNotMatch(output, /Cannot read properties of undefined/);
    if (failBackup) {
      assert.match(output, /WhatsApp shutdown was incomplete/i);
      assert.match(output, /backup shutdown failed/i);
      assert.match(output, /snapshot failed/i);
      assert.match(output, /storage failure/i);
      assert.match(output, /disk denied/i);
      assert.doesNotMatch(output, /secret-shutdown-fixture|secret-filter-fixture/);
    }
    const events = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.deepEqual(events, ['sessions-start', 'cleanup', 'disk', 'sync-stop', 'api-stop', 'sessions-stop-start', 'sessions-stop-done', 'backup-flush:true', 'telemetry']);
  });
}

test('shutdown errors identify each failing component and preserve their causes', async () => {
  const { safeText } = require('../utils/safeLog');
  const result = await stopSessionServices({
    sync: { stop: () => { throw new Error('sync offline token=secret-sync-fixture'); } },
    api: { stop: async () => { throw new Error('API socket close'); } },
    sessions: { stop: async () => { throw new Error('WhatsApp socket close'); } },
    backup: { stop: async () => { throw new Error('recovery write failed'); } },
  }).then(() => null, (error) => error);
  assert.ok(result instanceof AggregateError);
  const labels = result.errors.map((error) => error.message).sort();
  assert.deepEqual(labels, ['Dashboard API shutdown failed', 'Dashboard sync shutdown failed', 'Session backup shutdown failed', 'WhatsApp sessions shutdown failed'].sort());
  for (const error of result.errors) assert.ok(error.cause instanceof Error);
  const output = safeText(result);
  for (const detail of ['sync offline', 'API socket close', 'WhatsApp socket close', 'recovery write failed']) assert.ok(output.includes(detail));
  assert.doesNotMatch(output, /secret-sync-fixture/);
});
