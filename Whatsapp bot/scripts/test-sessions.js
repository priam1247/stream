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

test('approval is checked again before a queued message handler runs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-approval-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fx = fixture(root);
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('approval-race')] });
  fx.approved.delete('265991111111');
  await delay(5);
  assert.equal(fx.messages.length, 0);
});

test('a missing socket user still recognizes the saved primary identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-primary-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'creds.json'), JSON.stringify({ registered: true, me: { id: '265990000000:1@s.whatsapp.net' } }));
  const fx = fixture(root, { approved: ['265990000000'] });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const primary = fx.created[0]; open(primary, '265990000000');
  primary.user = null;
  assert.equal(fx.manager.status().accounts[0].number, '265990000000');
  await assert.rejects(fx.manager.requestPair('265990000000'), /already linked/i);
});

test('stopping a session waits for credential writes already accepted by the socket', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stop-creds-'));
  let release;
  const writeReady = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  let didWrite = false;
  const fx = fixture(root, {
    loadAuthState: async () => ({
      state: { creds: { registered: true, me: { id: '265990000000:1@s.whatsapp.net' } } },
      saveCreds: async () => { await writeReady; didWrite = true; },
    }),
  });
  await fx.manager.start();
  fx.created[0].ev.emit('creds.update');
  let stopped = false;
  const stopping = fx.manager.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'the process must not finish shutdown before the accepted credentials are saved');
  release();
  await stopping;
  assert.equal(didWrite, true);
});

test('shutdown waits for an accepted unlink and its recovery revocation before retiring sockets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stop-unlink-'));
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const revoked = [];
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  const fx = fixture(root, { onRevoked: (slot, generation) => revoked.push({ slot, generation }) });
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
  const { sessionId } = fx.manager.status().accounts.find((a) => a.number === '265991111111');
  sock.logout = async () => { await pending; sock.loggedOut = true; };
  const unlinking = fx.manager.unlinkAccount('265991111111', sessionId);
  let stopped = false;
  const stopping = fx.manager.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'shutdown must wait for an already accepted unlink');
  assert.equal(sock.ended, false, 'do not close the socket before logout completes');
  await assert.rejects(sock.sendMessage('chat', { text: 'stopped' }), /offline or paused/i);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('stop-message')] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.messages.length, 0, 'shutdown must stop taking new messages');
  await assert.rejects(fx.manager.unlinkAccount('265991111111', sessionId), { statusCode: 503 });
  release();
  await unlinking; await stopping;
  assert.deepEqual(revoked, [{ slot: 'linked:265991111111', generation: sessionId }]);
  assert.equal(sock.ended, true);
});

test('a pairing retry interrupted by shutdown cannot create a new session generation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stop-pair-'));
  let release; const closing = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  const fx = fixture(root);
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
  const before = fx.manager.status().accounts.find((a) => a.number === '265991111111').sessionId;
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  sock.end = async () => { await closing; };
  const pairing = fx.manager.requestPair('265991111111').catch((err) => err);
  await new Promise((resolve) => setImmediate(resolve));
  await fx.manager.stop();
  release();
  const error = await pairing;
  assert.equal(error.statusCode, 503);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'), 'utf8'));
  assert.equal(manifest.accounts['265991111111'].attempt, before, 'shutdown must not create a replacement generation');
});

test('a pairing retry rechecks approval after the previous socket closes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pair-recheck-'));
  let release; const closing = new Promise((resolve) => { release = resolve; });
  const fx = fixture(root);
  t.after(async () => { release(); await fx.manager.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
  const before = fx.manager.status().accounts.find((a) => a.number === '265991111111').sessionId;
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  sock.end = async () => { await closing; };
  const pairing = fx.manager.requestPair('265991111111').catch((err) => err);
  await new Promise((resolve) => setImmediate(resolve));
  fx.approved.delete('265991111111'); release();
  const error = await pairing;
  assert.equal(error.statusCode, 403);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'), 'utf8'));
  assert.equal(manifest.accounts['265991111111'].attempt, before);
});

test('duplicate unlink requests for the same generation share one WhatsApp logout', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-unlink-coalesce-'));
  let release; const closing = new Promise((resolve) => { release = resolve; });
  const fx = fixture(root);
  t.after(async () => { release(); await fx.manager.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  await waitFor(() => fx.manager.status().accounts.some((a) => a.number === '265991111111' && a.state === 'connected'));
  const { sessionId } = fx.manager.status().accounts.find((a) => a.number === '265991111111');
  let calls = 0;
  sock.logout = async () => { calls += 1; await closing; };
  const first = fx.manager.unlinkAccount('265991111111', sessionId);
  const second = fx.manager.unlinkAccount('265991111111', sessionId);
  assert.equal(calls, 1, 'only one logout request should be sent for a generation');
  release();
  assert.deepEqual(await first, await second);
});

test('a hung unlink is bounded during shutdown and its generation is quarantined without claiming success', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-unlink-stop-timeout-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const revoked = [];
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  const fx = fixture(root, {
    unlinkShutdownTimeoutMs: 20,
    retirementShutdownTimeoutMs: 20,
    onRevoked: (slot, generation) => revoked.push({ slot, generation }),
  });
  await fx.manager.start();
  const primary = fx.created[0];
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  const { sessionId } = fx.manager.status().accounts.find((a) => a.number === '265991111111');
  sock.logout = async () => { await gate; };
  let unlinkSettled = false;
  const unlinking = fx.manager.unlinkAccount('265991111111', sessionId).then((value) => { unlinkSettled = true; return value; });
  const stopping = fx.manager.stop().then(() => ({ error: null }), (error) => ({ error }));
  let timeout;
  const result = await Promise.race([stopping, new Promise((resolve) => { timeout = setTimeout(() => resolve('timeout'), 1500); })]);
  clearTimeout(timeout);
  if (result === 'timeout') { release(); await Promise.allSettled([unlinking, stopping]); }
  assert.notEqual(result, 'timeout', 'a blocked WhatsApp logout must not prevent other sessions from closing');
  assert.ok(result.error, 'the incomplete unlink must be visible to shutdown diagnostics');
  assert.match(require('node:util').inspect(result.error, { depth: 5 }), /unlink/i);
  assert.equal(unlinkSettled, false, 'an unresolved logout must not be reported as successful');
  assert.equal(primary.ended, true, 'unrelated sessions can still close');
  assert.deepEqual(revoked, [{ slot: 'linked:265991111111', generation: sessionId }]);
  assert.equal(fs.existsSync(path.join(root, 'linked', '265991111111', sessionId, 'creds.json')), true);
  release();
  assert.equal((await unlinking).unlinked, true, 'a real late success can complete normally');
});

test('a socket end that hangs does not indefinitely block shutdown of other sessions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-end-stop-timeout-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
  const fx = fixture(root, { retirementShutdownTimeoutMs: 20 });
  await fx.manager.start();
  const primary = fx.created[0];
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  sock.end = async () => { await gate; };
  const { stopSessionServices } = require('../utils/serviceStartup');
  let backupFlushed = false;
  const stopping = stopSessionServices({ sessions: fx.manager, backup: { stop: async (opts) => {
    assert.deepEqual(opts, { flush: true }); backupFlushed = true;
  } } }).then(() => ({ error: null }), (error) => ({ error }));
  let timeout;
  const result = await Promise.race([stopping, new Promise((resolve) => { timeout = setTimeout(() => resolve('timeout'), 1500); })]);
  clearTimeout(timeout);
  if (result === 'timeout') { release(); await stopping; }
  assert.notEqual(result, 'timeout', 'a blocked socket close must not prevent recovery flush');
  assert.ok(result.error, 'the incomplete socket close must be reported');
  assert.equal(backupFlushed, true, 'the lifecycle must still flush encrypted recovery');
  assert.equal(primary.ended, true);
  release();
});

test('a post-pair disconnect keeps Node alive until the WhatsApp reconnect runs', (t) => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-liveness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `
    const { EventEmitter } = require('node:events');
    const { createSessionManager } = require(${JSON.stringify(require.resolve('../utils/sessionManager'))});
    let sockets = 0;
    const manager = createSessionManager({
      sessionDir: process.argv[1],
      pairNumber: '12345678901',
      loadAuthState: async () => ({ state: { creds: { registered: false } }, saveCreds: async () => {} }),
      getVersion: async () => [2, 0, 0],
      makeSocket: () => {
        const sock = { ev: new EventEmitter(), requestPairingCode: async () => 'fixture-code', end: async () => {} };
        if (++sockets === 1) setImmediate(() => {
          sock.ev.emit('connection.update', { qr: 'fixture-ready' });
          setImmediate(() => sock.ev.emit('connection.update', {
            connection: 'close', lastDisconnect: { error: { message: 'private-disconnect-fixture', output: { statusCode: 515 } } },
          }));
        });
        else setImmediate(async () => { console.log('reconnected'); await manager.stop(); });
        return sock;
      },
      onConsoleCode: () => console.log('pairing-code-issued'),
      reconnectBaseMs: 30, reconnectMaxMs: 30, loggedOutCode: 401,
      log: { warn: (msg) => console.log(msg), error: (msg) => console.error(msg) },
    });
    manager.start().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', source, root], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 3000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /pairing-code-issued/);
  assert.match(child.stdout, /status 515.*retrying/i);
  assert.doesNotMatch(child.stdout + child.stderr, /private-disconnect-fixture|fixture-code/);
  assert.match(child.stdout, /reconnected/, 'Node exited cleanly before the scheduled retry ran');
});

test('stopping a pending reconnect releases its process handle', (t) => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = `
    const { createReconnector } = require(${JSON.stringify(require.resolve('../utils/reconnect'))});
    const reconnect = createReconnector({ start: () => console.log('unexpected retry'), baseMs: 60000 });
    reconnect.schedule();
    reconnect.stop();
    console.log('stopped');
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 2000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /stopped/);
  assert.doesNotMatch(child.stdout, /unexpected retry/);
});

test('disconnect diagnostics omit raw errors and coalesce duplicate retry notices', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-disconnect-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings = [];
  const fx = fixture(root, {
    reconnectBaseMs: 500, reconnectMaxMs: 500,
    log: { warn: (message) => warnings.push(message), error() {}, log() {} },
  });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const socket = fx.created[0];
  const update = { connection: 'close', lastDisconnect: { error: {
    message: 'private-disconnect-fixture', output: { statusCode: 'private-status-fixture' },
  } } };
  socket.ev.emit('connection.update', update);
  socket.ev.emit('connection.update', update);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /status unknown.*retrying in 500ms/i);
  assert.doesNotMatch(warnings[0], /private-disconnect-fixture|private-status-fixture/);
});

test('personal usage scope follows the approved session and its current ownership claim', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-usage-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let claim = 'a'.repeat(64);
  let approved = false;
  const fx = fixture(root, {
    enforceClaims: true,
    getClaim: () => claim,
    canPair: () => true,
    isAllowed: () => approved,
  });
  t.after(() => fx.manager.stop());
  await fx.manager.start();
  const { sock } = await request(fx, '265991111111');
  open(sock, '265991111111');
  assert.equal(sock.__memberUsageScope(), null, 'linking alone does not enable usage');
  approved = true; fx.manager.refreshPermissions();
  const scope = sock.__memberUsageScope();
  assert.equal(scope.number, '265991111111');
  assert.equal(scope.claimToken, claim);
  assert.match(scope.sessionId, /^[a-f0-9]{24}$/);
  claim = 'b'.repeat(64);
  assert.equal(sock.__memberUsageScope(), null, 'an ownership change immediately removes the old scope');
});
