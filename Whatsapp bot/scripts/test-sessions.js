'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSessionManager } = require('../utils/sessionManager');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms = 500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('timed out waiting for test condition');
}

function fixture(root, options = {}) {
  const created = [];
  const messages = [];
  const approved = new Set(options.approved || ['265991111111', '265992222222', '265993333333']);
  const loadAuthState = async (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    let creds;
    try { creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')); }
    catch { creds = { registered: false }; }
    return {
      state: { creds },
      saveCreds: async () => fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds)),
    };
  };
  const manager = createSessionManager({
    sessionDir: root,
    loadAuthState,
    getVersion: async () => [2, 0, 0],
    makeSocket: ({ auth }) => {
      const sock = {
        ev: new EventEmitter(),
        auth,
        user: auth.creds.me,
        ended: false,
        requestPairingCode: async (number) => `CODE-${number.slice(-4)}`,
        end: async () => { sock.ended = true; sock.ev.emit('connection.update', { connection: 'close' }); },
        logout: async () => { sock.loggedOut = true; sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }); },
        sendMessage: async () => ({}),
      };
      created.push(sock);
      return sock;
    },
    isAllowed: (number) => approved.has(number),
    onMessage: async (sock, msg) => messages.push([sock.__sessionId, msg.key.id]),
    loggedOutCode: 401,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    pairTimeoutMs: 150,
    codeLifetimeMs: 50,
    pendingLifetimeMs: 80,
    log: { warn() {}, error() {}, log() {} },
    ...options,
  });
  return { manager, created, messages, approved };
}

function open(sock, number) {
  sock.auth.creds.registered = true;
  sock.auth.creds.me = { id: `${number}:1@s.whatsapp.net` };
  sock.user = sock.auth.creds.me;
  sock.ev.emit('creds.update', sock.auth.creds);
  sock.ev.emit('connection.update', { connection: 'open' });
}

async function request(fx, number) {
  const before = fx.created.length;
  const promise = fx.manager.requestPair(number);
  await waitFor(() => fx.created.slice(before).some((s) => s.__sessionId === `linked:${number}`));
  const sock = fx.created.slice(before).find((s) => s.__sessionId === `linked:${number}`);
  sock.ev.emit('connection.update', { qr: 'ready' });
  return { result: await promise, sock };
}

function message(id, from = '265991111111@s.whatsapp.net') {
  return { key: { id, remoteJid: from }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: '.ping' } };
}

test('additional accounts pair independently, dispatch messages, and restore without touching the primary credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' }, marker: 'keep-me' }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const one = fx.manager.requestPair('265991111111');
  assert.strictEqual(fx.manager.requestPair('265991111111'), one, 'same-number requests must share one flight');
  const two = fx.manager.requestPair('265992222222');
  await waitFor(() => fx.created.length === 3);
  const a = fx.created.find((s) => s.__sessionId === 'linked:265991111111');
  const b = fx.created.find((s) => s.__sessionId === 'linked:265992222222');
  a.ev.emit('connection.update', { qr: 'ready' });
  b.ev.emit('connection.update', { qr: 'ready' });
  assert.equal((await one).code, 'CODE-1111');
  assert.equal((await two).code, 'CODE-2222');
  assert.equal(primary.ended, false, 'linking another account replaced the primary');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'creds.json'))).marker, 'keep-me');
  open(a, '265991111111');
  open(b, '265992222222');
  await waitFor(() => fs.existsSync(path.join(root, 'linked', 'accounts.json')) && fx.manager.status().accounts.filter((x) => x.state === 'connected').length === 3);

  for (const sock of [primary, a, b]) sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('same-id'), message('same-id')] });
  await waitFor(() => fx.messages.length === 3);
  assert.deepEqual(new Set(fx.messages.map((m) => m[0])), new Set(['primary', 'linked:265991111111', 'linked:265992222222']));
  fx.approved.delete('265991111111');
  a.ev.emit('messages.upsert', { type: 'notify', messages: [message('paused')] });
  assert.equal(fx.manager.status().accounts.find((x) => x.number === '265991111111').state, 'paused');
  assert.equal(fx.messages.length, 3);
  await assert.rejects(a.sendMessage('chat', { text: 'late result' }), /offline or paused/i);
  await primary.sendMessage('chat', { text: 'primary still works' });
  fx.approved.add('265991111111');
  fx.manager.refreshPermissions();
  await a.sendMessage('chat', { text: 'resumed' });
  a.ev.emit('messages.upsert', { type: 'notify', messages: [message('resumed')] });
  await waitFor(() => fx.messages.length === 4);

  await assert.rejects(fx.manager.requestPair('265991111111'), /already linked/i);
  await assert.rejects(fx.manager.requestPair('265990000000'), /approve|already linked/i);
  await fx.manager.stop();
  const restarted = fixture(root);
  t.after(() => restarted.manager.stop());
  await restarted.manager.start();
  assert.equal(restarted.created.length, 3, 'all registered accounts must be restored');
  assert.deepEqual(new Set(restarted.created.map((s) => s.__sessionId)), new Set(['primary', 'linked:265991111111', 'linked:265992222222']));
  await assert.rejects(restarted.manager.requestPair('265991111111'), /already linked/i);
});

test('pending accounts may link but cannot execute commands before approval', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const approved = new Set();
  const fx = fixture(root, { isAllowed: (number) => approved.has(number), canPair: (number) => number === '265991111111' });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'paused'));
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('pending')] });
  await delay(5); assert.equal(fx.messages.length, 0);
  await assert.rejects(sock.sendMessage('chat', { text: 'not permitted' }), /paused/i);
  approved.add('265991111111'); fx.manager.refreshPermissions();
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('approved')] });
  await waitFor(() => fx.messages.length === 1);
  assert.equal(fx.messages[0][1], 'approved');
});

test('expired codes can be retried without deleting previous session data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const first = await request(fx, '265991111111');
  const originalFolder = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts['265991111111'].attempt;
  await delay(90);
  assert.equal(fx.manager.status().accounts.find((a) => a.number === '265991111111').state, 'expired');
  assert.equal(first.sock.ended, true);
  const second = await request(fx, '265991111111');
  const nextFolder = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts['265991111111'].attempt;
  assert.notEqual(originalFolder, nextFolder);
  assert.ok(fs.existsSync(path.join(root, 'linked', '265991111111', originalFolder)), 'previous credentials were deleted');
  assert.ok(!second.sock.ended);
});

test('a revoked number and a damaged account index fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  await assert.rejects(fx.manager.requestPair('265999999999'), /approve and enable/i);
  await fx.manager.stop();
  fs.mkdirSync(path.join(root, 'linked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'linked', 'accounts.json'), '{broken');
  const corrupt = fixture(root);
  t.after(() => corrupt.manager.stop());
  await corrupt.manager.start();
  await assert.rejects(corrupt.manager.requestPair('265991111111'), /index is unavailable/i);
  assert.equal(fs.readFileSync(path.join(root, 'linked', 'accounts.json'), 'utf8'), '{broken');
});

test('a transient disconnect reconnects only the affected account and logout permits a fresh link', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await waitFor(() => fx.created.length === 3);
  assert.equal(primary.ended, false);
  const reconnected = fx.created[2];
  open(reconnected, '265991111111');
  reconnected.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(fx.manager.status().accounts.find((a) => a.number === '265991111111').state, 'logged_out');
  const fresh = await request(fx, '265991111111');
  assert.equal(fresh.result.code, 'CODE-1111');
  assert.equal(primary.ended, false);
});

test('approval revoked during code issuance prevents the result and does not interrupt another account', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-revoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  let finish;
  const code = new Promise((resolve) => { finish = resolve; });
  const pending = fx.manager.requestPair('265991111111');
  await waitFor(() => fx.created.length === 2);
  const linked = fx.created[1];
  linked.requestPairingCode = () => code;
  linked.ev.emit('connection.update', { qr: 'ready' });
  fx.approved.delete('265991111111');
  fx.manager.refreshPermissions();
  finish('SECRET-CODE');
  await assert.rejects(pending, /no longer enabled/i);
  assert.equal(primary.ended, false);
  assert.equal(linked.__canRespond(), false);
});

test('restart reconciles registered pending credentials and refuses missing credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = '265991111111';
  const bad = '265992222222';
  const a = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  fs.mkdirSync(path.join(root, 'linked', good, a), { recursive: true });
  fs.mkdirSync(path.join(root, 'linked', bad, b), { recursive: true });
  fs.writeFileSync(path.join(root, 'linked', good, a, 'creds.json'), JSON.stringify({ registered: true, me: { id: `${good}:1@s.whatsapp.net` } }));
  fs.writeFileSync(path.join(root, 'linked', 'accounts.json'), JSON.stringify({ version: 1, accounts: { [good]: { attempt: a, state: 'pending' }, [bad]: { attempt: b, state: 'active' } } }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  assert.deepEqual(fx.created.map((s) => s.__sessionId).sort(), ['primary', `linked:${good}`].sort());
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts;
  assert.equal(saved[good].state, 'active');
  assert.equal(saved[bad].state, 'expired');
  assert.equal(fs.existsSync(path.join(root, 'linked', bad, b)), true, 'old session files must not be removed');
  await assert.rejects(fx.manager.requestPair(good), /already linked/i);
});

test('a logged-out primary is not silently reconnected by a runtime reload', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-logout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  primary.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await fx.manager.reconnectAll();
  assert.equal(fx.created.length, 1);
  assert.equal(fx.manager.status().accounts[0].state, 'logged_out');
});

test('a retry cannot replace a socket whose registration just completed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-registration-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { codeLifetimeMs: 20, pendingLifetimeMs: 1000 });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  // Simulate companion_finish before the asynchronous save/manifest update.
  sock.auth.creds.registered = true;
  await delay(30);
  await assert.rejects(fx.manager.requestPair('265991111111'), /already linked/i);
  assert.equal(sock.ended, false);
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
});

test('unlink logs out only the requested linked generation and preserves the primary credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-unlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' }, marker: 'primary-safe' }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
  const account = fx.manager.status().accounts.find((a) => a.number === '265991111111');
  assert.match(account.sessionId, /^[a-f0-9]{24}$/);
  assert.ok(account.linkedAt > 0, 'actual linking date is reported');
  await assert.rejects(fx.manager.unlinkAccount('265991111111', 'f'.repeat(24)), /session has changed/i);
  await assert.rejects(fx.manager.unlinkAccount('265990000000', account.sessionId), /session has changed/i);
  assert.equal(sock.loggedOut, undefined);
  assert.deepEqual(await fx.manager.unlinkAccount('265991111111', account.sessionId), { number: '265991111111', sessionId: account.sessionId, unlinked: true });
  assert.equal(sock.loggedOut, true);
  assert.equal(primary.ended, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'creds.json'))).marker, 'primary-safe');
  assert.equal(fx.manager.status().accounts.find((a) => a.number === '265991111111').state, 'logged_out');
  const replacement = await request(fx, '265991111111');
  open(replacement.sock, '265991111111');
  await assert.rejects(fx.manager.unlinkAccount('265991111111', account.sessionId), /session has changed/i);
  assert.equal(replacement.sock.loggedOut, undefined);
});

test('a failed WhatsApp logout does not claim unlink success or discard the session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-unlink-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  const account = fx.manager.status().accounts.find((a) => a.number === '265991111111');
  sock.logout = async () => { throw new Error('socket unavailable'); };
  await assert.rejects(fx.manager.unlinkAccount(account.number, account.sessionId), /socket unavailable/);
  assert.equal(fx.manager.status().accounts.find((a) => a.number === '265991111111').state, 'connected');
  assert.equal(sock.ended, false);
});

test('ownership changes pause and retire the old session before a new claim can pair', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-claim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const number = '265991111111';
  let claim = 'a'.repeat(64);
  const revoked = [];
  const fx = fixture(root, { enforceClaims: true, canPair: (n) => n === number, getClaim: () => claim, onRevoked: (slot, generation) => revoked.push({ slot, generation }) });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const old = await request(fx, number);
  open(old.sock, number);
  await waitFor(() => fx.manager.status().accounts.some((item) => item.number === number && item.state === 'connected'));
  const oldRecord = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts[number];
  assert.equal(fx.manager.status().accounts.find((item) => item.number === number).claimToken, claim);
  claim = 'b'.repeat(64);
  await assert.rejects(old.sock.sendMessage('chat', { text: 'old owner' }), /paused/i);
  fx.manager.refreshPermissions();
  assert.equal(old.sock.ended, true);
  assert.deepEqual(revoked, [{ slot: `linked:${number}`, generation: oldRecord.attempt }]);
  assert.ok(fs.existsSync(path.join(root, 'linked', number, oldRecord.attempt, 'creds.json')));
  const next = await request(fx, number);
  const newRecord = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'))).accounts[number];
  assert.notEqual(newRecord.attempt, oldRecord.attempt);
  assert.equal(newRecord.claim, claim);
  assert.notEqual(next.sock, old.sock);
});

test('the failover gate blocks primary and linked devices from handling or sending while on standby', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-failover-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' } }));
  let serving = false;
  const fx = fixture(root, { canServe: () => serving });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0];
  open(primary, '265990000000');
  primary.ev.emit('messages.upsert', { type: 'notify', messages: [message('standby')] });
  await delay(5);
  assert.equal(fx.messages.length, 0);
  await assert.rejects(primary.sendMessage('chat', { text: 'blocked' }), /offline or paused/i);

  serving = true;
  fx.manager.refreshPermissions();
  primary.ev.emit('messages.upsert', { type: 'notify', messages: [message('active')] });
  await waitFor(() => fx.messages.length === 1);
  await primary.sendMessage('chat', { text: 'allowed' });
  const { sock: linked } = await request(fx, '265991111111');
  open(linked, '265991111111');
  await linked.sendMessage('chat', { text: 'allowed too' });

  // The lease can expire after the event listener runs but before the queued
  // handler microtask starts.
  primary.ev.emit('messages.upsert', { type: 'notify', messages: [message('queued-before-expiry')] });
  serving = false;
  await delay(5);
  assert.equal(fx.messages.length, 1);
  primary.ev.emit('messages.upsert', { type: 'notify', messages: [message('expired')] });
  await delay(5);
  assert.equal(fx.messages.length, 1);
  linked.ev.emit('messages.upsert', { type: 'notify', messages: [message('linked-standby')] });
  await delay(5);
  assert.equal(fx.messages.length, 1);
  await assert.rejects(primary.sendMessage('chat', { text: 'late result' }), /offline or paused/i);
  await assert.rejects(linked.sendMessage('chat', { text: 'linked standby' }), /offline or paused/i);
});

test('failover health tracks the primary device independently of connected members', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-failover-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' } }));
  const fx = fixture(root, { reconnectBaseMs: 5000 });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0]; open(primary, '265990000000');
  const { sock: linked } = await request(fx, '265991111111'); open(linked, '265991111111');
  assert.equal(fx.manager.status().primaryConnected, true);
  assert.equal(fx.manager.status().primaryNumber, '265990000000');
  primary.ev.emit('connection.update', { connection: 'close' });
  assert.equal(fx.manager.status().primaryConnected, false);
  assert.equal(fx.manager.status().connected, true);
  assert.equal(fx.manager.status().botNumber, '265991111111', 'legacy status still reports the online member');
  assert.equal(fx.manager.status().primaryNumber, '265990000000', 'failover identity must remain the primary number');
  primary.user = null;
  assert.equal(fx.manager.status().primaryNumber, '265990000000', 'saved primary credentials remain usable during reconnect');
});

test('a pairing command whose epoch expires during auth cannot create a socket or request a code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lease-pair-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' } }));
  let release, loading = false, epoch = 1;
  const gate = new Promise((resolve) => { release = resolve; });
  const fx = fixture(root, {
    canServe: () => true,
    loadAuthState: async (dir) => {
      if (dir.includes(`${path.sep}linked${path.sep}`)) { loading = true; await gate; }
      fs.mkdirSync(dir, { recursive: true });
      let creds;
      try { creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')); } catch { creds = { registered: false }; }
      return { state: { creds }, saveCreds: async () => {} };
    },
  });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const pair = fx.manager.requestPair('265991111111', { canExecute: () => epoch === 1 });
  const rejected = assert.rejects(pair, /lease|ownership/i);
  await waitFor(() => loading);
  epoch = 2; // this host might even hold a new lease; the old command is stale
  release();
  await Promise.race([rejected, delay(300).then(() => assert.fail('stale pairing did not stop'))]);
  assert.equal(fx.created.filter((sock) => sock.__sessionId === 'linked:265991111111').length, 0);
});

test('a stale pairing epoch is checked again immediately before requesting the WhatsApp code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lease-pair-qr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { canServe: () => true });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  let epoch = 1, codeRequests = 0;
  const pair = fx.manager.requestPair('265991111111', { canExecute: () => epoch === 1 });
  const rejected = assert.rejects(pair, /lease|ownership/i);
  await waitFor(() => fx.created.some((sock) => sock.__sessionId === 'linked:265991111111'));
  const linked = fx.created.find((sock) => sock.__sessionId === 'linked:265991111111');
  linked.requestPairingCode = async () => { codeRequests++; return 'NEVER'; };
  epoch = 2;
  linked.ev.emit('connection.update', { qr: 'ready' });
  await Promise.race([rejected, delay(300).then(() => assert.fail('stale pairing did not stop'))]);
  assert.equal(codeRequests, 0);
});

test('unlink checks the command epoch immediately before logging out the linked device', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lease-unlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { canServe: () => true });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  const sessionId = fx.manager.status().accounts.find((item) => item.number === '265991111111').sessionId;
  let checks = 0;
  await assert.rejects(fx.manager.unlinkAccount('265991111111', sessionId, { canExecute: () => ++checks === 1 }), /lease|ownership/i);
  assert.equal(sock.loggedOut, undefined);
  assert.equal(sock.ended, false);
});

test('a code already being requested is discarded if its command loses the lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lease-pair-flight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root, { canServe: () => true });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  let epoch = 1, requested = false, release;
  const wait = new Promise((resolve) => { release = resolve; });
  const pair = fx.manager.requestPair('265991111111', { canExecute: () => epoch === 1 });
  const rejected = assert.rejects(pair, /lease|ownership/i);
  await waitFor(() => fx.created.some((sock) => sock.__sessionId === 'linked:265991111111'));
  const linked = fx.created.find((sock) => sock.__sessionId === 'linked:265991111111');
  linked.requestPairingCode = async () => { requested = true; return wait; };
  linked.ev.emit('connection.update', { qr: 'ready' });
  await waitFor(() => requested);
  epoch = 2;
  release('STALE-CODE');
  await Promise.race([rejected, delay(300).then(() => assert.fail('stale pairing did not stop'))]);
  assert.equal(linked.ended, true);
});

test('losing a lease actively retires an unregistered member pairing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lease-retire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let serving = true;
  const fx = fixture(root, { canServe: () => serving });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const pair = fx.manager.requestPair('265991111111');
  const rejected = assert.rejects(pair, /lease|ownership/i);
  await waitFor(() => fx.created.some((sock) => sock.__sessionId === 'linked:265991111111'));
  const linked = fx.created.find((sock) => sock.__sessionId === 'linked:265991111111');
  serving = false;
  fx.manager.refreshPermissions();
  await rejected;
  assert.equal(linked.ended, true);
});

test('the real sync bridge and session manager fence a pairing across a handover', async (t) => {
  const { createFailoverLease } = require('../utils/failoverLease');
  const { startDashboardSync } = require('../utils/dashboardSync');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lease-bridge-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let release, loading = false, calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  let manager;
  const lease = createFailoverLease('xs', { instance: 'a'.repeat(32), onChange: () => manager?.refreshPermissions() });
  const fx = fixture(root, {
    canServe: () => lease.canServe(),
    loadAuthState: async (dir) => {
      if (dir.includes(`${path.sep}linked${path.sep}`)) { loading = true; await gate; }
      fs.mkdirSync(dir, { recursive: true });
      return { state: { creds: { registered: false } }, saveCreds: async () => {} };
    },
  });
  manager = fx.manager;
  t.after(() => manager.stop());
  await manager.start();
  const bodies = [];
  const sync = startDashboardSync({ dashboardUrl: 'https://dashboard.example', token: 'test-token', manualOnly: true,
    wlFile: path.join(root, 'whitelist.json'), failover: lease,
    requestPairing: (number, options) => manager.requestPair(number, options),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({
        failover: ++calls === 1 ? { granted: true, role: 'xs', instance: 'a'.repeat(32), epoch: 1, ttlMs: 30_000 } : { granted: false },
        whitelistChanged: calls === 1, whitelistVersion: '0123456789abcdef', users: [{ number: '265991111111', enabled: true }],
        commands: calls === 1 ? [{ id: 'pair', type: 'pair', payload: { number: '265991111111' }, expiresAt: Date.now() + 60_000 }] : [],
      }) };
    },
  });
  t.after(() => sync.stop());
  await sync.syncNow();
  await waitFor(() => loading);
  await sync.syncNow();
  release();
  await delay(5);
  await sync.syncNow();
  assert.equal(fx.created.filter((sock) => sock.__sessionId === 'linked:265991111111').length, 0);
  assert.deepEqual(bodies[2].completedResults, []);
});
