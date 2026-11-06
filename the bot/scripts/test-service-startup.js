'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSessionServices, stopSessionServices, createServiceLifecycle } = require('../gateway/sessions/startup');

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
  const id = require.resolve('../lib/cleanup');
  delete require.cache[id];
  require(id);
  assert.equal(process.listenerCount('SIGTERM'), before.term);
  assert.equal(process.listenerCount('SIGINT'), before.int);
});

for (const [signal, failBackup] of [['SIGTERM', false], ['SIGINT', false], ['SIGTERM', 'sensitive'], ['SIGTERM', 'private'], ['SIGTERM', 'binary'], ['SIGTERM', 'benign']]) {
  test(`the bot entry point handles ${signal} and flushes session recovery${failBackup ? ` while reporting a ${failBackup} failure` : ''}`, async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const root = path.resolve(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-entry-stop-'));
    const marker = path.join(dir, 'events');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.mkdirSync(path.join(dir, 'gateway', 'sessions'), { recursive: true });
    fs.copyFileSync(path.join(root, 'gateway', 'sessions', 'startup.js'), path.join(dir, 'gateway', 'sessions', 'startup.js'));
    fs.copyFileSync(path.join(root, 'lib', 'safeLog.js'), path.join(dir, 'lib', 'safeLog.js'));
    fs.copyFileSync(path.join(root, 'index.js'), path.join(dir, 'index.js'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(dir, 'preload.cjs'), `
      const Module = require('node:module');
      const fs = require('node:fs');
      const mark = (name) => fs.appendFileSync(process.env.TEST_MARKER, name + '\\n');
      const ffmpeg = () => 'ffmpeg'; ffmpeg.works = () => false;
      const logger = () => ({info(){},warn(){},error(){},debug(){}}); logger.banner = () => {};
      const fake = {
        './lib/tempManager': { initializeTempSystem() {} },
        './lib/cleanup': { startCleanup() {}, stopCleanup() { mark('cleanup'); }, cleanupOldFiles() {} },
        './lib/diskGuard': { startDiskGuard() {}, stopDiskGuard() { mark('disk'); } },
        './lib/jobDelivery': { protectPendingFiles() {} },
        'pino': () => ({ info() {} }),
        '@whiskeysockets/baileys': { default() {}, useMultiFileAuthState() {}, DisconnectReason: { loggedOut: 401 }, Browsers: { ubuntu() {} }, fetchLatestWaWebVersion: async () => ({}) },
        'qrcode-terminal': { generate() {} },
        './config': { sessionID: '', sessionName: 'session', prefix: '.', botName: 'Test', admin: { dashboardUrl: 'https://example.invalid', syncToken: 'test', apiEnabled: true, token: 'test', port: 1234 } },
        './gateway/handler': { handleMessage() {} },
        './lib/hotReload': { onReload() {} },
        './lib/jid': { isSystemJid() { return false; } },
        './gateway/sessions/manager': { createSessionManager: () => ({ start: async () => { mark('sessions-start'); }, stop: async () => { mark('sessions-stop-start'); await new Promise((r) => setTimeout(r, 20)); mark('sessions-stop-done'); }, status: () => ({}) }) },
        './gateway/users/access': { readWL: () => ({ users: [] }) },
        './gateway/sessions/backup': { createSessionBackup: () => ({ restore: async () => {}, wrapAuth() {}, status: () => ({}), stop: async (opts) => { mark('backup-flush:' + opts?.flush); if (process.env.TEST_FAIL_BACKUP) throw new AggregateError([new Error('snapshot failed', { cause: new Error('storage failure token=secret-shutdown-fixture', { cause: new Error('disk denied') }) })], 'backup flush failed'); } }) },
        './gateway/dashboard/sync': { startDashboardSync: () => ({ enabled: true, stop() { mark('sync-stop'); if (process.env.TEST_FAIL_BACKUP) throw new Error(({ sensitive: 'closing session token=secret-filter-fixture registrationId=12345 chainKey=private-session-fixture', private: 'closing session privateKey=secret-private-key-fixture', binary: 'closing session: Buffer barebinarysecretfixturebarebinarysecretfixture12345678', benign: 'closing session: socket offline token=secret-filter-fixture' })[process.env.TEST_FAIL_BACKUP]); } }), triggerImmediateSync() {} },
        './gateway/dashboard/api': { startAdminApi: () => { setImmediate(() => { process.emit('unhandledRejection', undefined); process.stdout.write('SERVICE_READY\\n'); }); return { stop: async () => { mark('api-stop'); } }; } },
        './lib/logger': logger,
        './lib/youtube/youtubedl': {},
        './lib/ffmpeg': ffmpeg,
        './lib/nm3u8dl': { ensureInstalled: async () => null },
        './lib/telemetry': { flushNow() { mark('telemetry'); } },
        './lib/dbBackup': { start() {}, snapshot() {} }, // backups are covered in test-structure.js
      };
      const original = Module._load;
      Module._load = function (request, parent, isMain) {
        if (parent?.filename.endsWith('/index.js') && Object.hasOwn(fake, request)) return fake[request];
        return original.apply(this, arguments);
      };
    `);
    const child = spawn(process.execPath, ['--require', path.join(dir, 'preload.cjs'), path.join(dir, 'index.js')], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', TEST_MARKER: marker, ...(failBackup ? { TEST_FAIL_BACKUP: failBackup } : {}) },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
    let output = ''; let signalled = false; let signalTimer;
    child.stdout.on('data', (data) => {
      output += data;
      // All fake sockets and dashboard components are deliberately idle: the
      // real entry point must remain available even with no external handles.
      if (!signalTimer && output.includes('SERVICE_READY')) {
        signalTimer = setTimeout(() => { signalled = child.kill(signal); }, 100);
      }
    });
    child.stderr.on('data', (data) => { output += data; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('isolated bot did not stop in time')); }, 5000);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', (code, exitSignal) => { clearTimeout(timer); resolve({ code, exitSignal }); });
    });
    clearTimeout(signalTimer);
    assert.equal(signalled, true, `service exited before ${signal} could be sent: ${output}`);
    assert.deepEqual(result, { code: 0, exitSignal: null });
    assert.doesNotMatch(output, /Cannot read properties of undefined/);
    if (failBackup) {
      assert.match(output, /WhatsApp shutdown was incomplete/i);
      assert.match(output, /Dashboard sync shutdown failed/i);
      assert.match(output, /closing session/i);
      if (failBackup === 'benign') assert.match(output, /socket offline/i);
      else assert.match(output, /sensitive session details omitted/i);
      assert.match(output, /backup shutdown failed/i);
      assert.match(output, /snapshot failed/i);
      assert.match(output, /storage failure/i);
      assert.match(output, /disk denied/i);
      assert.doesNotMatch(output, /secret-shutdown-fixture|secret-filter-fixture|private-session-fixture|secret-private-key-fixture|barebinarysecretfixture|registrationId=12345/);
    }
    const events = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.deepEqual(events, ['sessions-start', 'cleanup', 'disk', 'sync-stop', 'api-stop', 'sessions-stop-start', 'sessions-stop-done', 'backup-flush:true', 'telemetry']);
  });
}

test('shutdown errors identify each failing component and preserve their causes', async () => {
  const { safeText } = require('../lib/safeLog');
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
