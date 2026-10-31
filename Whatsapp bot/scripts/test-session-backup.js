'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('node:module');
const { createBotFixture, clearHostConfig } = require('./test-sandbox');

clearHostConfig();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-source-'));
const BOT = createBotFixture(TMP);
const botRequire = createRequire(path.join(BOT, 'scripts', 'test-session-backup.js'));
process.chdir(TMP);
const { createSessionBackup, seal, open, validatePayload } = botRequire('../utils/sessionBackup');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const key = crypto.randomBytes(32);
const keyText = key.toString('base64');
const attempt = 'a'.repeat(24);
const claimToken = 'b'.repeat(64);
const number = '265991234567';
const quiet = { info() {}, warn() {}, error() {} };
const creds = JSON.stringify({ registered: true, registrationId: 12345, me: { id: `${number}:1@s.whatsapp.net` }, secretMarker: 'PRIVATE_SESSION_DATA' });
function server() {
  const rows = new Map();
  return { rows, fetch: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'list') return Response.json({ ok: true, records: [...rows.values()].filter((row) => row.slot > (body.after || '')).map(({ ciphertext, ...rest }) => rest) });
    const old = rows.get(body.slot);
    if (body.action === 'meta') return old ? Response.json({ ok: true, record: { ...old, ciphertext: undefined } }) : Response.json({ error: 'missing' }, { status: 404 });
    if (body.action === 'get') return old && !old.revoked ? Response.json({ ok: true, record: old }) : Response.json({ error: 'missing' }, { status: 404 });
    if (body.action === 'put') {
      if ((old?.revision || 0) !== body.revision) return Response.json({ error: 'conflict' }, { status: 409 });
      const row = { slot: body.slot, generation: body.generation, claimToken: body.claimToken, revision: (old?.revision || 0) + 1, ciphertext: body.ciphertext, revoked: false, updatedAt: Date.now() };
      rows.set(body.slot, row); return Response.json({ ok: true, revision: row.revision });
    }
    if (body.action === 'revoke') {
      if (!old || old.generation === body.generation) rows.set(body.slot, { slot: body.slot, generation: body.generation, revision: (old?.revision || 0) + 1, ciphertext: '', revoked: true, updatedAt: Date.now() });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'invalid' }, { status: 400 });
  } };
}
function controller(base, service, secret = keyText) {
  return createSessionBackup({ sessionDir: path.join(base, 'session'), statePath: path.join(base, 'state.json'), dashboardUrl: 'https://example.test', token: 'test-token', key: secret, fetchImpl: service.fetch, log: quiet });
}
function putLocal(base) {
  const root = path.join(base, 'session'); const dir = path.join(root, 'linked', number, attempt);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'creds.json'), creds);
  fs.writeFileSync(path.join(dir, 'creds.json'), creds);
  fs.writeFileSync(path.join(dir, 'session-123.json'), JSON.stringify({ testKey: 'PRIVATE_KEY' }));
  fs.writeFileSync(path.join(root, 'linked', 'accounts.json'), JSON.stringify({ version: 1, accounts: { [number]: { state: 'active', attempt, claim: claimToken, linkedAt: 123456 } } }));
  return { root, dir };
}
function primaryGeneration() {
  const parsed = JSON.parse(creds);
  return crypto.createHash('sha256').update(JSON.stringify([parsed.registrationId, parsed.me.id, null])).digest('hex').slice(0, 24);
}

test('authenticated encryption rejects wrong keys, tampering and unsafe files', () => {
  const payload = { version: 1, slot: `linked:${number}`, generation: attempt, claimToken, files: { 'creds.json': creds } };
  const encrypted = seal(payload, key, payload.slot, attempt);
  assert.ok(!encrypted.includes('PRIVATE_SESSION_DATA'));
  assert.deepEqual(open(encrypted, key, payload.slot, attempt), payload);
  assert.throws(() => open(encrypted, crypto.randomBytes(32), payload.slot, attempt));
  assert.throws(() => open(encrypted, key, `linked:265999999999`, attempt));
  const parts = encrypted.split(':'); parts[2] = Buffer.alloc(16).toString('base64');
  assert.throws(() => open(parts.join(':'), key, payload.slot, attempt));
  assert.throws(() => validatePayload({ ...payload, files: { 'creds.json': creds, '../escape.json': '{}' } }, payload.slot, attempt));
});

test('encrypted primary and linked credentials restore on an empty replacement without exposing plaintext', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const old = path.join(tmp, 'old'); const replacement = path.join(tmp, 'replacement');
  const service = server(); const local = putLocal(old); const backup = controller(old, service);
  await backup.restore();
  await backup._snapshot({ slot: 'primary', generation: primaryGeneration(), dir: local.root });
  await backup._snapshot({ slot: `linked:${number}`, generation: attempt, dir: local.dir, number });
  assert.equal(service.rows.size, 2);
  assert.deepEqual({ sessions: backup.status().sessions, backedUp: backup.status().backedUp }, { sessions: 2, backedUp: 2 });
  backup.schedule(local.dir);
  assert.equal(backup.status().backedUp, 1, 'a pending upload is not counted as current');
  await backup.stop();
  assert.ok(!JSON.stringify([...service.rows.values()]).includes('PRIVATE_SESSION_DATA'));
  assert.ok(!JSON.stringify([...service.rows.values()]).includes('PRIVATE_KEY'));
  const restored = controller(replacement, service); await restored.restore();
  assert.equal(fs.readFileSync(path.join(replacement, 'session', 'creds.json'), 'utf8'), creds);
  assert.equal(fs.readFileSync(path.join(replacement, 'session', 'linked', number, attempt, 'session-123.json'), 'utf8'), JSON.stringify({ testKey: 'PRIVATE_KEY' }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(replacement, 'session', 'linked', 'accounts.json'))).accounts[number].state, 'active');
});

test('local corrupt or newer files are never overwritten, and a wrong key fails closed', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conflict-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); const old = path.join(tmp, 'old'); const local = putLocal(old);
  const first = controller(old, service); await first.restore(); await first._snapshot({ slot: 'primary', generation: primaryGeneration(), dir: local.root });
  const destination = path.join(tmp, 'existing'); fs.mkdirSync(path.join(destination, 'session'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'session', 'creds.json'), '{corrupt local data');
  const existing = controller(destination, service); await existing.restore();
  assert.equal(existing.status().state, 'conflict');
  assert.equal(fs.readFileSync(path.join(destination, 'session', 'creds.json'), 'utf8'), '{corrupt local data');
  await existing._snapshot({ slot: 'primary', generation: primaryGeneration(), dir: path.join(destination, 'session') });
  assert.equal(service.rows.get('primary').revision, 1);
  const wrong = controller(path.join(tmp, 'wrong'), service, crypto.randomBytes(32).toString('base64'));
  await assert.rejects(wrong.restore(), /authenticate/i);
  assert.equal(fs.existsSync(path.join(tmp, 'wrong', 'session', 'creds.json')), false);
});

test('a revoked generation cannot be restored or overwritten by a delayed upload', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-revoked-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); const old = path.join(tmp, 'old'); const local = putLocal(old);
  const backup = controller(old, service); await backup.restore();
  const desc = { slot: `linked:${number}`, generation: attempt, dir: local.dir, number };
  await backup._snapshot(desc); await backup.revoke(desc.slot, attempt); await backup._snapshot(desc);
  assert.equal(service.rows.get(desc.slot).revoked, true); assert.equal(service.rows.get(desc.slot).ciphertext, '');
  const replacement = controller(path.join(tmp, 'new'), service); await replacement.restore();
  assert.equal(fs.existsSync(path.join(tmp, 'new', 'session', 'linked', number)), false);
});

test('a failed logout is persisted and flushed before recovery on restart', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-revoke-outbox-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); let offline = false;
  const flaky = { rows: service.rows, fetch: async (...args) => {
    if (offline) return Response.json({ error: 'offline' }, { status: 503 });
    return service.fetch(...args);
  } };
  const base = path.join(tmp, 'old'); const local = putLocal(base); const first = controller(base, flaky);
  await first.restore();
  const desc = { slot: `linked:${number}`, generation: attempt, dir: local.dir, number };
  await first._snapshot(desc);
  offline = true;
  await first.revoke(desc.slot, attempt);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'state.json'))).revocations, [{ slot: desc.slot, generation: attempt }]);
  assert.equal(first.status().state, 'error');
  await first.stop();
  const restarted = controller(base, flaky);
  await assert.rejects(restarted.restore(), /HTTP 503/);
  assert.equal(service.rows.get(desc.slot).revoked, false);
  offline = false;
  await restarted.restore();
  assert.equal(service.rows.get(desc.slot).revoked, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'state.json'))).revocations, []);
  assert.equal(restarted.status().state, 'ready');
  const replacement = controller(path.join(tmp, 'replacement'), flaky); await replacement.restore();
  assert.equal(fs.existsSync(path.join(tmp, 'replacement', 'session', 'linked', number)), false);
  await restarted.stop(); await replacement.stop();
});

test('a delayed revocation does not clear newer local generation metadata', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-old-revoke-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); const slot = `linked:${number}`; const newer = 'c'.repeat(24);
  service.rows.set(slot, { slot, generation: newer, revision: 7, ciphertext: 'encrypted', revoked: false, updatedAt: Date.now() });
  fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ version: 1, slots: { [slot]: { generation: newer, revision: 7 } } }));
  const backup = controller(tmp, service); await backup.revoke(slot, attempt);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'))).slots[slot], { generation: newer, revision: 7 });
  assert.equal(service.rows.get(slot).revoked, false);
  await backup.stop();
});

test('graceful backup stop flushes pending primary and linked snapshots', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-stop-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); const local = putLocal(tmp);
  const backup = controller(tmp, service);
  await backup.restore();
  backup.schedule(local.root);
  backup.schedule(local.dir);
  await backup.stop({ flush: true });
  assert.equal(service.rows.size, 2, 'pending encrypted recovery data should not be dropped on clean shutdown');
  const replacement = controller(path.join(tmp, 'replacement'), service);
  await replacement.restore();
  assert.equal(fs.readFileSync(path.join(tmp, 'replacement', 'session', 'creds.json'), 'utf8'), creds);
  assert.equal(fs.readFileSync(path.join(tmp, 'replacement', 'session', 'linked', number, attempt, 'session-123.json'), 'utf8'), JSON.stringify({ testKey: 'PRIVATE_KEY' }));
  await replacement.stop();
});

test('graceful backup stop waits for an in-flight credential write before snapshotting', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-write-stop-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); const local = putLocal(tmp);
  const backup = controller(tmp, service); await backup.restore();
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {
    await ready;
    fs.writeFileSync(path.join(local.root, 'creds.json'), creds.replace('PRIVATE_SESSION_DATA', 'LATEST_SESSION_DATA'));
  } }), local.root);
  const writing = auth.saveCreds();
  const stopping = backup.stop({ flush: true });
  release(); await writing; await stopping;
  const replacement = controller(path.join(tmp, 'replacement'), service); await replacement.restore();
  assert.match(fs.readFileSync(path.join(tmp, 'replacement', 'session', 'creds.json'), 'utf8'), /LATEST_SESSION_DATA/);
  await replacement.stop();
});

test('graceful backup stop retries an in-flight upload that fails during shutdown', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-upload-stop-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = server(); let announce, release; let puts = 0;
  const started = new Promise((resolve) => { announce = resolve; });
  const ready = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const flaky = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'put' && ++puts === 1) { announce(); await ready; return Response.json({ error: 'offline' }, { status: 503 }); }
    return base.fetch(url, opts);
  } };
  const local = putLocal(tmp); const backup = controller(tmp, flaky); await backup.restore();
  const upload = backup._snapshot({ slot: 'primary', generation: primaryGeneration(), dir: local.root }).catch(() => {});
  await started;
  const stopping = backup.stop({ flush: true });
  release(); await upload; await stopping;
  assert.equal(puts, 2);
  assert.equal(base.rows.has('primary'), true);
});

test('a revocation arriving during a credential write prevents the waiting backup upload', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-revoke-race-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const service = server(); const local = putLocal(tmp); const backup = controller(tmp, service); await backup.restore();
  const desc = { slot: `linked:${number}`, generation: attempt, dir: local.dir, number };
  await backup._snapshot(desc);
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => ready } }, saveCreds: async () => {} }), local.dir);
  const writing = auth.state.keys.set({});
  const uploading = backup._snapshot(desc);
  await new Promise((resolve) => setImmediate(resolve));
  await backup.revoke(desc.slot, attempt);
  release(); await writing; await uploading;
  assert.equal(service.rows.get(desc.slot).revoked, true, 'a stale upload must not restore a revoked session');
  await backup.stop({ flush: true });
});

test('a credential write accepted during the final upload is included before backup stop returns', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-late-creds-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(tmp, { recursive: true, force: true }); });
  let announce; const started = new Promise((resolve) => { announce = resolve; });
  const base = server(); let puts = 0;
  const service = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'put' && body.slot === 'primary' && ++puts === 1) { announce(); await gate; }
    return base.fetch(url, opts);
  } };
  const local = putLocal(tmp); const backup = controller(tmp, service); await backup.restore();
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {
    fs.writeFileSync(path.join(local.root, 'creds.json'), creds.replace('PRIVATE_SESSION_DATA', 'LATE_CREDENTIAL_FIXTURE'));
  } }), local.root);
  const stopping = backup.stop({ flush: true });
  await started;
  await auth.saveCreds();
  release(); await stopping;
  const row = base.rows.get('primary');
  const payload = open(row.ciphertext, key, 'primary', row.generation);
  assert.match(payload.files['creds.json'], /LATE_CREDENTIAL_FIXTURE/);
  assert.equal(puts, 2, 'the changed session must be uploaded again');
});

test('a late key write for a different slot is drained even after that slot finished uploading', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-late-keys-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(tmp, { recursive: true, force: true }); });
  let primaryStarted, linkedSaved, linkedResaved;
  const primaryInFlight = new Promise((resolve) => { primaryStarted = resolve; });
  const linkedUploaded = new Promise((resolve) => { linkedSaved = resolve; });
  const linkedReuploaded = new Promise((resolve) => { linkedResaved = resolve; });
  const base = server(); let linkedPuts = 0;
  const service = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'put' && body.slot === 'primary') { primaryStarted(); await gate; }
    const result = await base.fetch(url, opts);
    if (body.action === 'put' && body.slot === `linked:${number}`) { linkedPuts++; linkedSaved(); if (linkedPuts === 2) linkedResaved(); }
    return result;
  } };
  const local = putLocal(tmp); const backup = controller(tmp, service); await backup.restore();
  const load = async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {} });
  await backup.wrapAuth(load, local.root);
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {
    fs.writeFileSync(path.join(local.dir, 'session-123.json'), JSON.stringify({ testKey: 'LATE_KEY_FIXTURE' }));
  } } }, saveCreds: async () => {} }), local.dir);
  const stopping = backup.stop({ flush: true });
  await Promise.all([primaryInFlight, linkedUploaded]);
  await auth.state.keys.set({});
  let timeout;
  const progressed = await Promise.race([linkedReuploaded.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1500); })]);
  clearTimeout(timeout);
  if (!progressed) { release(); await stopping; }
  assert.equal(progressed, true, 'a slow upload in one slot must not block a late write from another slot');
  release(); await stopping;
  const row = base.rows.get(`linked:${number}`);
  const payload = open(row.ciphertext, key, row.slot, row.generation);
  assert.match(payload.files['session-123.json'], /LATE_KEY_FIXTURE/);
  assert.equal(linkedPuts, 2);
});

test('a timed-out unlink revokes only that recovery generation while other sessions flush', async (t) => {
  const { EventEmitter } = require('node:events');
  const { createSessionManager } = botRequire('../utils/sessionManager');
  const { stopSessionServices } = botRequire('../utils/serviceStartup');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-unlink-timeout-'));
  let releaseLogout; const logoutGate = new Promise((resolve) => { releaseLogout = resolve; });
  let releaseRevoke; const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  t.after(() => { releaseLogout(); releaseRevoke(); fs.rmSync(tmp, { recursive: true, force: true }); });
  let primarySaved; const primaryUploaded = new Promise((resolve) => { primarySaved = resolve; });
  const base = server();
  const service = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'revoke') await revokeGate;
    const response = await base.fetch(url, opts);
    if (body.action === 'put' && body.slot === 'primary') primarySaved();
    return response;
  } };
  const local = putLocal(tmp); const backup = controller(tmp, service); await backup.restore();
  const sockets = [];
  const manager = createSessionManager({
    sessionDir: local.root,
    unlinkShutdownTimeoutMs: 20, retirementShutdownTimeoutMs: 20,
    isAllowed: () => true,
    loadAuthState: (dir) => backup.wrapAuth(async () => ({
      state: { creds: JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')), keys: { set: async () => {} } },
      saveCreds: async () => {},
    }), dir),
    getVersion: async () => [2, 0, 0],
    makeSocket: ({ auth }) => {
      const sock = { ev: new EventEmitter(), auth, user: auth.creds.me,
        end: async () => {}, logout: async () => { await logoutGate; }, sendMessage: async () => ({}) };
      sockets.push(sock); return sock;
    },
    onRevoked: (slot, generation) => { void backup.revoke(slot, generation); },
    log: quiet,
  });
  await manager.start();
  for (const sock of sockets) sock.ev.emit('connection.update', { connection: 'open' });
  assert.equal(sockets.length, 2);
  let unlinkSettled = false;
  const unlinking = manager.unlinkAccount(number, attempt).then((value) => { unlinkSettled = true; return value; });
  const stopping = stopSessionServices({ sessions: manager, backup }).then(() => null, (error) => error);
  // A slow revocation must not serialize an unrelated primary backup behind it.
  let timeout;
  const primaryFlushed = await Promise.race([primaryUploaded.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1500); })]);
  clearTimeout(timeout);
  if (!primaryFlushed) { releaseLogout(); releaseRevoke(); await Promise.allSettled([unlinking, stopping]); }
  assert.equal(primaryFlushed, true, 'other sessions should flush while revocation is in flight');
  assert.equal(unlinkSettled, false, 'an unknown logout outcome is not success');
  assert.equal(JSON.parse(fs.readFileSync(path.join(local.root, 'linked', 'accounts.json'))).accounts[number].state, 'active');
  assert.equal(fs.existsSync(path.join(local.dir, 'creds.json')), true, 'local credentials remain untouched');
  releaseRevoke();
  assert.ok(await stopping instanceof AggregateError, 'the timeout is reported even though backup still flushes');
  assert.equal(base.rows.get(`linked:${number}`).generation, attempt);
  assert.equal(base.rows.get(`linked:${number}`).revoked, true);
  assert.equal(base.rows.get('primary').revoked, false);
  releaseLogout();
  assert.equal((await unlinking).unlinked, true, 'only an actual late logout may report success');
  assert.equal(base.rows.get(`linked:${number}`).revoked, true, 'a late success cannot resurrect recovery');
  const replacement = controller(path.join(tmp, 'replacement'), base); await replacement.restore();
  assert.equal(fs.existsSync(path.join(tmp, 'replacement', 'session', 'creds.json')), true);
  assert.equal(fs.existsSync(path.join(tmp, 'replacement', 'session', 'linked', number)), false);
  await replacement.stop();
});

test('a failed late logout stays unconfirmed and an offline recovery revocation remains queued', async (t) => {
  const { EventEmitter } = require('node:events');
  const { createSessionManager } = botRequire('../utils/sessionManager');
  const { stopSessionServices } = botRequire('../utils/serviceStartup');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-uncertain-'));
  let release; const logoutGate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(tmp, { recursive: true, force: true }); });
  let offline = false;
  const base = server();
  const flaky = { fetch: async (...args) => {
    const body = JSON.parse(args[1].body);
    if (offline && body.action === 'revoke') return Response.json({ error: 'offline' }, { status: 503 });
    return base.fetch(...args);
  } };
  const local = putLocal(tmp); const backup = controller(tmp, flaky); await backup.restore();
  await backup._snapshot({ slot: `linked:${number}`, generation: attempt, dir: local.dir, number });
  offline = true;
  const sockets = [];
  const manager = createSessionManager({
    sessionDir: local.root, isAllowed: () => true, unlinkShutdownTimeoutMs: 20, retirementShutdownTimeoutMs: 20,
    loadAuthState: (dir) => backup.wrapAuth(async () => ({
      state: { creds: JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')), keys: { set: async () => {} } },
      saveCreds: async () => {},
    }), dir),
    getVersion: async () => [2, 0, 0],
    makeSocket: ({ auth }) => {
      const sock = { ev: new EventEmitter(), auth, user: auth.creds.me, end: async () => {},
        logout: async () => { await logoutGate; throw new Error('late logout failure'); }, sendMessage: async () => ({}) };
      sockets.push(sock); return sock;
    },
    onRevoked: (slot, generation) => { void backup.revoke(slot, generation); }, log: quiet,
  });
  await manager.start();
  for (const sock of sockets) sock.ev.emit('connection.update', { connection: 'open' });
  const unlinking = manager.unlinkAccount(number, attempt).then(() => null, (error) => error);
  await assert.rejects(stopSessionServices({ sessions: manager, backup }), AggregateError);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'))).revocations, [{ slot: `linked:${number}`, generation: attempt }]);
  assert.equal(backup.status().state, 'error');
  assert.equal(base.rows.get(`linked:${number}`).revoked, false, 'an offline remote cannot be claimed as revoked');
  assert.equal(base.rows.get('primary').revoked, false, 'other sessions still flush');
  assert.equal(JSON.parse(fs.readFileSync(path.join(local.root, 'linked', 'accounts.json'))).accounts[number].state, 'active');
  release();
  assert.match((await unlinking).message, /late logout failure/);
  assert.equal(fs.existsSync(path.join(local.dir, 'creds.json')), true);
  offline = false;
  const restarted = controller(tmp, flaky); await restarted.restore();
  assert.equal(base.rows.get(`linked:${number}`).revoked, true, 'the original host must flush the queued revocation on restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'))).revocations, []);
  assert.equal(fs.existsSync(path.join(local.dir, 'creds.json')), true, 'retrying the revocation never deletes local credentials');
  await restarted.stop();
});

test('a local credential write after the final backup boundary is preserved and warned about', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-after-stop-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = server(); const local = putLocal(tmp); const warnings = [];
  const backup = createSessionBackup({ sessionDir: local.root, statePath: path.join(tmp, 'state.json'),
    dashboardUrl: 'https://example.test', token: 'test-token', key: keyText, fetchImpl: base.fetch,
    log: { info() {}, error() {}, warn: (message) => warnings.push(message) } });
  await backup.restore();
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {
    fs.writeFileSync(path.join(local.root, 'creds.json'), creds.replace('PRIVATE_SESSION_DATA', 'AFTER_STOP_FIXTURE'));
  } }), local.root);
  await backup.stop({ flush: true });
  await auth.saveCreds();
  assert.match(fs.readFileSync(path.join(local.root, 'creds.json'), 'utf8'), /AFTER_STOP_FIXTURE/);
  assert.equal(backup.status().state, 'error');
  assert.ok(warnings.some((warning) => /after recovery stopped/i.test(warning)));
  const row = base.rows.get('primary');
  assert.doesNotMatch(open(row.ciphertext, key, row.slot, row.generation).files['creds.json'], /AFTER_STOP_FIXTURE/);
});

test('a final snapshot never uploads changed primary credentials under the previous generation', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-generation-race-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const local = putLocal(tmp); const base = server(); const attemptedGenerations = [];
  const service = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'put' && body.slot === 'primary') attemptedGenerations.push(body.generation);
    return base.fetch(url, opts);
  } };
  const backup = controller(tmp, service); await backup.restore();
  const updated = JSON.parse(creds); updated.registrationId = 98765;
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {
    await gate; fs.writeFileSync(path.join(local.root, 'creds.json'), JSON.stringify(updated));
  } }), local.root);
  const writing = auth.saveCreds();
  const stopping = backup.stop({ flush: true });
  await new Promise((resolve) => setImmediate(resolve));
  release(); await writing; await stopping;
  const newGeneration = crypto.createHash('sha256').update(JSON.stringify([updated.registrationId, updated.me.id, null])).digest('hex').slice(0, 24);
  assert.deepEqual(attemptedGenerations, [newGeneration]);
  assert.equal(base.rows.get('primary').generation, newGeneration);
});

test('a failed final encrypted snapshot reports its cause after preserving local files', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-stop-failure-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const base = server();
  const service = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'put') return Response.json({ error: 'offline' }, { status: 503 });
    return base.fetch(url, opts);
  } };
  const local = putLocal(tmp); const backup = controller(tmp, service); await backup.restore();
  backup.schedule(local.root);
  const error = await backup.stop({ flush: true }).then(() => null, (err) => err);
  assert.ok(error instanceof AggregateError, 'shutdown diagnostics must include failed final snapshots');
  assert.equal(error.errors[0].cause.statusCode, 503);
  assert.equal(backup.status().state, 'error');
  assert.equal(fs.readFileSync(path.join(local.root, 'creds.json'), 'utf8'), creds);
});

test('a later successful snapshot clears an earlier final-flush failure', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-final-retry-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let announce; const started = new Promise((resolve) => { announce = resolve; });
  t.after(() => { release(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const local = putLocal(tmp); const base = server(); let puts = 0;
  const service = { fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'put' && body.slot === 'primary' && ++puts === 1) {
      announce(); await gate; return Response.json({ error: 'offline' }, { status: 503 });
    }
    return base.fetch(url, opts);
  } };
  const backup = controller(tmp, service); await backup.restore();
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {
    fs.writeFileSync(path.join(local.root, 'creds.json'), creds.replace('PRIVATE_SESSION_DATA', 'RETRY_FIXTURE'));
  } }), local.root);
  const stopping = backup.stop({ flush: true });
  await started; await auth.saveCreds(); release(); await stopping;
  assert.equal(puts, 2);
  assert.equal(backup.status().state, 'ready');
  const row = base.rows.get('primary');
  assert.match(open(row.ciphertext, key, row.slot, row.generation).files['creds.json'], /RETRY_FIXTURE/);
});

test('a re-paired primary is backed up when its identity changes inside the debounce window', { timeout: 4000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-primary-debounce-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const local = putLocal(tmp); const base = server(); let announce;
  const uploaded = new Promise((resolve) => { announce = resolve; });
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); const response = await base.fetch(url, opts);
    if (body.action === 'put' && body.slot === 'primary') announce();
    return response;
  };
  const backup = createSessionBackup({ sessionDir: local.root, statePath: path.join(tmp, 'state.json'),
    dashboardUrl: 'https://example.test', token: 'test-token', key: keyText, fetchImpl, delayMs: 100, log: quiet });
  await backup.restore();
  const updated = JSON.parse(creds); updated.registrationId = 67890;
  const auth = await backup.wrapAuth(async () => ({ state: { keys: { set: async () => {} } }, saveCreds: async () => {
    fs.writeFileSync(path.join(local.root, 'creds.json'), JSON.stringify(updated));
  } }), local.root);
  await auth.saveCreds();
  let timeout;
  const saved = await Promise.race([uploaded.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1500); })]);
  clearTimeout(timeout);
  await backup.stop();
  assert.equal(saved, true, 'the pending timer must back up the new identity without another write');
  const row = base.rows.get('primary');
  const newGeneration = crypto.createHash('sha256').update(JSON.stringify([updated.registrationId, updated.me.id, null])).digest('hex').slice(0, 24);
  assert.equal(row.generation, newGeneration);
  assert.equal(JSON.parse(open(row.ciphertext, key, row.slot, row.generation).files['creds.json']).registrationId, 67890);
});

test('a stale primary descriptor schedules a fresh generation snapshot after releasing its lock', { timeout: 4000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-stale-descriptor-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const local = putLocal(tmp); const base = server(); let announce;
  const uploaded = new Promise((resolve) => { announce = resolve; });
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); const response = await base.fetch(url, opts);
    if (body.action === 'put' && body.slot === 'primary') announce();
    return response;
  };
  const backup = createSessionBackup({ sessionDir: local.root, statePath: path.join(tmp, 'state.json'),
    dashboardUrl: 'https://example.test', token: 'test-token', key: keyText, fetchImpl, delayMs: 100, log: quiet });
  await backup.restore();
  const updated = JSON.parse(creds); updated.registrationId = 24680;
  fs.writeFileSync(path.join(local.root, 'creds.json'), JSON.stringify(updated));
  await backup._snapshot({ slot: 'primary', generation: primaryGeneration(), dir: local.root });
  let timeout;
  const saved = await Promise.race([uploaded.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1500); })]);
  clearTimeout(timeout);
  await backup.stop();
  assert.equal(saved, true, 'a stale descriptor must be retried without waiting for an unrelated write');
  const row = base.rows.get('primary');
  assert.equal(JSON.parse(open(row.ciphertext, key, row.slot, row.generation).files['creds.json']).registrationId, 24680);
});

test('revoking an old linked generation does not cancel a pending backup for its replacement', { timeout: 4000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-pending-generation-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const local = putLocal(tmp); const base = server(); let announce;
  const uploaded = new Promise((resolve) => { announce = resolve; });
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); const response = await base.fetch(url, opts);
    if (body.action === 'put' && body.slot === `linked:${number}`) announce();
    return response;
  };
  const backup = createSessionBackup({ sessionDir: local.root, statePath: path.join(tmp, 'state.json'),
    dashboardUrl: 'https://example.test', token: 'test-token', key: keyText, fetchImpl, delayMs: 100, log: quiet });
  await backup.restore();
  backup.schedule(local.dir);
  const newer = 'c'.repeat(24); const newDir = path.join(local.root, 'linked', number, newer);
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'creds.json'), creds.replace('PRIVATE_SESSION_DATA', 'NEW_GENERATION_FIXTURE'));
  const manifestFile = path.join(local.root, 'linked', 'accounts.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.accounts[number].attempt = newer;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  backup.schedule(newDir);
  backup.schedule(local.dir); // an older queued write cannot replace the new generation's pending work
  await backup.revoke(`linked:${number}`, attempt);
  let timeout;
  const saved = await Promise.race([uploaded.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1500); })]);
  clearTimeout(timeout);
  await backup.stop();
  assert.equal(saved, true, 'revoking an old generation must not discard a newer pending snapshot');
  const row = base.rows.get(`linked:${number}`);
  assert.equal(row.generation, newer);
  assert.equal(row.revoked, false);
  assert.match(open(row.ciphertext, key, row.slot, row.generation).files['creds.json'], /NEW_GENERATION_FIXTURE/);
});
