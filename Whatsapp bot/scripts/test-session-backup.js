'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createSessionBackup, seal, open, validatePayload } = require('../utils/sessionBackup');

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
