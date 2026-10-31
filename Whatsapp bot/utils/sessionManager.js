'use strict';

// Manages one legacy session and additional independent, persistent sessions.
// Dependencies are injected so the complete lifecycle can be tested offline.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createReconnector } = require('./reconnect');
const { readJsonSafe, writeJsonAtomic } = require('./jsonStore');
const sockets = require('./accountSockets');

const NUMBER_RE = /^\d{7,15}$/;
const ATTEMPT_RE = /^[a-f0-9]{24}$/;
const STORED_STATES = new Set(['pending', 'active', 'expired', 'logged_out']);

function credentialsOnDisk(dir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
    return creds && typeof creds === 'object' ? creds : null;
  } catch { return null; }
}

function numberFromCreds(creds) {
  const n = String(creds?.me?.id || '').split(':')[0].split('@')[0];
  return NUMBER_RE.test(n) ? n : null;
}

function createSessionManager(opts) {
  const primaryDir = path.resolve(opts.sessionDir || 'session');
  const linkedRoot = path.join(primaryDir, 'linked');
  const manifestFile = path.join(linkedRoot, 'accounts.json');
  const maxAccounts = Math.max(1, Math.min(100, Number(opts.maxAccounts) || 20));
  const pairTimeoutMs = Math.max(1, Number(opts.pairTimeoutMs) || 40_000);
  const codeLifetimeMs = Math.max(1, Number(opts.codeLifetimeMs) || 60_000);
  const pendingLifetimeMs = Math.max(codeLifetimeMs, Number(opts.pendingLifetimeMs) || 120_000);
  const log = opts.log || console;
  const allowed = (number) => {
    try {
      if (!opts.isAllowed?.(number)) return false;
      if (!opts.enforceClaims) return true;
      const expected = manifest.accounts[number]?.claim || '';
      const current = String(opts.getClaim?.(number) || '');
      return /^[a-f0-9]{64}$/.test(expected) && expected === current;
    } catch { return false; }
  };
  const canPair = (number) => {
    try { return opts.canPair ? Boolean(opts.canPair(number)) : allowed(number); } catch { return false; }
  };
  // Optional failover gate also covers the primary account and every outgoing
  // reply, including work that began before the active lease expired.
  const canServe = () => { try { return opts.canServe ? opts.canServe() === true : true; } catch { return false; } };
  const ownsCommand = (guard) => {
    try { return canServe() && (guard === undefined || (typeof guard === 'function' && guard() === true)); }
    catch { return false; }
  };
  const leaseError = () => Object.assign(new Error('This command no longer owns the WhatsApp lease.'), { statusCode: 409, code: 'STALE_LEASE' });
  const assertCommand = (guard) => { if (!ownsCommand(guard)) throw leaseError(); };
  const notify = () => { try { opts.onStatusChange?.(); } catch { /* non-fatal */ } };
  const validManifest = (data) => Boolean(
    data && data.version === 1 && data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts) &&
    Object.entries(data.accounts).every(([number, record]) =>
      NUMBER_RE.test(number) && record && ATTEMPT_RE.test(String(record.attempt || '')) && STORED_STATES.has(record.state)),
  );
  const stored = readJsonSafe(manifestFile, { defaultValue: { version: 1, accounts: {} }, validate: validManifest });
  // Refuse to replace a corrupt index: credentials may still be recoverable.
  let manifestError = !stored.ok;
  const manifest = stored.ok ? stored.data : { version: 1, accounts: {} };
  if (manifestError) log.error('Linked-account index is unreadable; preserved session files. Restore its backup before adding accounts.');

  const entries = new Map();
  const flights = new Map();
  let stopped = false;
  let started = false;

  function writeRecord(number, record) {
    if (manifestError) throw Object.assign(new Error('Linked-account index is unavailable. Restore its backup first.'), { statusCode: 503 });
    const previous = manifest.accounts[number];
    manifest.accounts[number] = record;
    try { writeJsonAtomic(manifestFile, manifest); }
    catch (err) {
      if (previous) manifest.accounts[number] = previous;
      else delete manifest.accounts[number];
      throw err;
    }
  }

  function mark(entry, state) {
    entry.status = state;
    if (!entry.number || manifest.accounts[entry.number]?.attempt !== entry.attempt) return;
    if (manifest.accounts[entry.number].state === state) return;
    const previous = manifest.accounts[entry.number];
    const linkedAt = previous.linkedAt || (state === 'active' && previous.state === 'pending' ? Date.now() : undefined);
    try { writeRecord(entry.number, { ...previous, attempt: entry.attempt, state, ...(linkedAt ? { linkedAt } : {}) }); }
    catch (err) { log.error(`Could not save linked-account state: ${err.message}`); }
  }

  function newEntry({ id, number = null, attempt = null, state = 'pending', pairNumber = '' }) {
    const entry = {
      id, number, attempt,
      dir: number ? path.join(linkedRoot, number, attempt) : primaryDir,
      status: state, pairNumber, sock: null, auth: null, connected: false,
      stopped: false, starting: null, requestStarted: false, pairResult: null, pairGuard: undefined,
      waiters: [], expiryTimer: null, seen: new Map(),
    };
    entry.reconnector = createReconnector({
      baseMs: opts.reconnectBaseMs || 3000,
      maxMs: opts.reconnectMaxMs || 60_000,
      start: () => connect(entry),
      onError: (err) => log.warn(`Connection retry failed: ${err?.message || err}`),
    });
    return entry;
  }

  const primary = newEntry({ id: sockets.PRIMARY_SESSION, state: 'active', pairNumber: String(opts.pairNumber || '').replace(/\D/g, '') });
  entries.set(primary.id, primary);
  for (const [number, record] of Object.entries(manifest.accounts)) {
    const entry = newEntry({ id: `linked:${number}`, number, attempt: record.attempt, state: record.state });
    entries.set(entry.id, entry);
  }

  function settlePair(entry, err, result) {
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (err) waiter.reject(err); else waiter.resolve(result);
    }
  }

  function waitForCode(entry) {
    if (entry.pairResult && Date.now() < entry.pairResult.issuedAt + codeLifetimeMs) return Promise.resolve(entry.pairResult);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = entry.waiters.indexOf(waiter);
        if (i !== -1) entry.waiters.splice(i, 1);
        reject(Object.assign(new Error('WhatsApp did not issue a linking code in time. Please try again.'), { statusCode: 504 }));
      }, pairTimeoutMs);
      waiter.timer.unref?.();
      entry.waiters.push(waiter);
    });
  }

  async function retire(entry, reason = 'Session replaced') {
    entry.stopped = true;
    entry.reconnector.stop();
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    settlePair(entry, Object.assign(new Error(reason), { statusCode: 409 }));
    const old = entry.sock;
    entry.sock = null;
    entry.connected = false;
    if (old) {
      old.__superseded = true;
      sockets.setOffline(entry.id, old);
      try { await old.end(new Error(reason)); } catch { /* already closed */ }
    }
    notify();
  }

  function scheduleExpiry(entry) {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = setTimeout(() => {
      if (entry.connected || entry.auth?.creds?.registered || entry.stopped) return;
      mark(entry, 'expired');
      void retire(entry, 'Linking code expired');
    }, pendingLifetimeMs);
    entry.expiryTimer.unref?.();
  }

  async function issueCode(entry, sock) {
    if (!entry.pairNumber || entry.requestStarted || entry.stopped || entry.sock !== sock || entry.auth?.creds?.registered) return;
    entry.requestStarted = true;
    try {
      // Primary devices must be able to pair before any lease exists. Member
      // pairing commands, however, must still own their original epoch at the
      // exact point where WhatsApp is asked to issue a code.
      if (entry.number) assertCommand(entry.pairGuard);
      if (entry.number && !canPair(entry.number)) {
        throw Object.assign(new Error('Number is no longer enabled'), { statusCode: 403 });
      }
      if (entry.number) assertCommand(entry.pairGuard);
      const code = await sock.requestPairingCode(entry.pairNumber);
      if (entry.number) assertCommand(entry.pairGuard);
      if (entry.number && !canPair(entry.number)) {
        throw Object.assign(new Error('Number is no longer enabled'), { statusCode: 403 });
      }
      if (entry.stopped || entry.sock !== sock) return;
      if (!code) throw new Error('No code was returned');
      const result = { code: String(code), issuedAt: Date.now(), expiresInSeconds: Math.floor(codeLifetimeMs / 1000) || 1 };
      entry.pairResult = result;
      if (!entry.number) opts.onConsoleCode?.(result.code);
      settlePair(entry, null, result);
      if (entry.number) scheduleExpiry(entry);
      notify();
    } catch (err) {
      if (entry.stopped || entry.sock !== sock) return;
      log.warn(`Could not request a linking code: ${err?.message || err}`);
      const error = err?.code === 'STALE_LEASE' ? leaseError() : Object.assign(new Error(err?.statusCode === 403
        ? 'This number is no longer enabled.'
        : 'WhatsApp could not issue a linking code. Please try again.'), { statusCode: err?.statusCode === 403 ? 403 : 502 });
      settlePair(entry, error);
      if (entry.number) {
        mark(entry, 'expired');
        void retire(entry, 'Linking request failed');
      }
    }
  }

  async function connect(entry) {
    if (stopped || entry.stopped) return null;
    if (entry.starting) return entry.starting;
    entry.starting = (async () => {
      if (entry.sock) {
        const old = entry.sock;
        entry.sock = null;
        entry.connected = false;
        old.__superseded = true;
        sockets.setOffline(entry.id, old);
        try { await old.end(new Error('reconnecting')); } catch { /* already closed */ }
      }
      entry.requestStarted = false;
      if (entry.number && entry.status === 'pending' && entry.pairGuard && !entry.auth?.creds?.registered) assertCommand(entry.pairGuard);
      const auth = await opts.loadAuthState(entry.dir);
      if (stopped || entry.stopped) return null;
      entry.auth = auth.state;
      if (entry.number && entry.status === 'pending' && entry.pairGuard && !entry.auth?.creds?.registered) assertCommand(entry.pairGuard);
      const version = await opts.getVersion();
      if (stopped || entry.stopped) return null;
      if (entry.number && entry.status === 'pending' && entry.pairGuard && !entry.auth?.creds?.registered) assertCommand(entry.pairGuard);
      const sock = opts.makeSocket({ auth: auth.state, version });
      sock.__sessionId = entry.id;
      sock.__sessionDir = entry.dir;
      sock.__accountNumber = entry.number;
      sock.__canRespond = () => canServe() && (!entry.number || allowed(entry.number));
      entry.sock = sock;
      // A long-running command can finish after approval is revoked or after
      // its socket is replaced. Recheck at send time as well as at dispatch.
      if (typeof sock.sendMessage === 'function') {
        const sendMessage = sock.sendMessage;
        sock.sendMessage = function (...args) {
          if (entry.stopped || entry.sock !== sock || !sock.__canRespond()) {
            return Promise.reject(new Error('This WhatsApp account is offline or paused.'));
          }
          return sendMessage.apply(sock, args);
        };
      }

      sock.ev.on('creds.update', () => {
        if (entry.stopped || sock.__superseded || entry.sock !== sock) return;
        Promise.resolve().then(() => auth.saveCreds()).then(() => {
          if (entry.number && entry.auth?.creds?.registered && !entry.stopped) {
            mark(entry, 'active');
            if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
            entry.expiryTimer = null;
          }
        }).catch((err) => log.error(`Could not save WhatsApp credentials: ${err?.message || err}`));
      });

      sock.ev.on('connection.update', (update) => {
        if (entry.stopped || sock.__superseded || entry.sock !== sock) return;
        if (update.qr) {
          if (entry.pairNumber) void issueCode(entry, sock);
          else if (!entry.number) opts.onQr?.(update.qr);
        }
        if (update.connection === 'open') {
          entry.connected = true;
          entry.pairNumber = '';
          entry.pairResult = null;
          if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
          entry.expiryTimer = null;
          if (entry.number) mark(entry, 'active');
          else entry.status = 'active';
          entry.reconnector.reset();
          sockets.setOnline(entry.id, sock);
          try { opts.onOpen?.(sock); } catch (err) { log.warn(`Connection handler failed: ${err.message}`); }
          notify();
        } else if (update.connection === 'close') {
          entry.connected = false;
          sockets.setOffline(entry.id, sock);
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          if (statusCode === opts.loggedOutCode) {
            entry.reconnector.stop();
            if (entry.number) mark(entry, 'logged_out');
            else entry.status = 'logged_out';
            try { opts.onRevoked?.(entry.number ? `linked:${entry.number}` : 'primary', entry.attempt || 'primary'); } catch { /* recovery retry is independent */ }
            settlePair(entry, Object.assign(new Error('WhatsApp logged out. Request a new linking code.'), { statusCode: 409 }));
            log.warn('A WhatsApp session was logged out. Its credentials were preserved.');
          } else {
            entry.reconnector.schedule();
          }
          notify();
        }
      });

      sock.ev.on('messages.upsert', ({ messages = [], type }) => {
        if (type !== 'notify' || entry.stopped || entry.sock !== sock || !entry.connected || !sock.__canRespond()) return;
        const now = Date.now();
        for (const [key, at] of entry.seen) if (now - at > 5 * 60_000) entry.seen.delete(key);
        for (const msg of messages) {
          const from = msg?.key?.remoteJid;
          const id = msg?.key?.id;
          if (!msg?.message || !id || !from || opts.isSystemJid?.(from)) continue;
          const key = `${from}:${id}`;
          if (entry.seen.has(key)) continue;
          const sentAt = Number(msg.messageTimestamp) * 1000;
          if (sentAt && now - sentAt > 5 * 60_000) continue;
          entry.seen.set(key, now);
          Promise.resolve().then(() => {
            // The lease/approval can change before this queued microtask runs.
            if (entry.stopped || entry.sock !== sock || !entry.connected || !sock.__canRespond()) return;
            return opts.onMessage(sock, msg);
          }).catch((err) => {
            if (!/rate-overlimit|not-authorized/.test(err?.message || '')) log.error(`Message handling failed: ${err?.message || err}`);
          });
        }
      });
      sock.ev.on('error', (err) => {
        const code = err?.output?.statusCode;
        if (![515, 503, 408].includes(code)) log.error(`WhatsApp socket error: ${err?.message || err}`);
      });
      return sock;
    })();
    try { return await entry.starting; }
    finally { entry.starting = null; }
  }

  async function startEntry(entry) {
    if (entry.stopped) return;
    try { await connect(entry); }
    catch (err) {
      if (err?.code === 'STALE_LEASE' && entry.number && !entry.auth?.creds?.registered) {
        settlePair(entry, leaseError());
        mark(entry, 'expired');
        await retire(entry, 'Linking command no longer owns the lease');
        return;
      }
      log.warn(`Could not start a WhatsApp session: ${err?.message || err}`);
      entry.reconnector.schedule();
    }
  }

  async function start() {
    if (started) return;
    started = true;
    const tasks = [startEntry(primary)];
    for (const entry of entries.values()) {
      if (!entry.number || entry.status === 'logged_out' || entry.status === 'expired') continue;
      const creds = credentialsOnDisk(entry.dir);
      // An interrupted registration, including a crash just after the open
      // event but before credentials were saved, must be linked again.
      if (!creds?.registered) {
        mark(entry, 'expired');
        continue;
      }
      if (creds?.registered && entry.status === 'pending') mark(entry, 'active');
      tasks.push(startEntry(entry));
    }
    await Promise.all(tasks);
  }

  function primaryNumber() {
    return numberFromCreds({ me: primary.sock?.user }) || numberFromCreds(primary.auth?.creds) || numberFromCreds(credentialsOnDisk(primaryDir));
  }

  async function doRequestPair(number, guard) {
    assertCommand(guard);
    if (stopped) throw Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 });
    if (manifestError) throw Object.assign(new Error('Linked-account index is unavailable. Restore its backup first.'), { statusCode: 503 });
    if (!canPair(number)) throw Object.assign(new Error('Approve and enable this number for linking.'), { statusCode: 403 });
    if (primary.status !== 'logged_out' && primaryNumber() === number) {
      throw Object.assign(new Error('This WhatsApp account is already linked. Wait for it to reconnect if necessary.'), { statusCode: 409 });
    }
    const old = entries.get(`linked:${number}`);
    // Registration may complete just before the async credentials save updates
    // the manifest. Never replace that newly registered socket on a retry.
    if (old && (old.status === 'active' || (old.status === 'pending' && (old.auth?.creds?.registered || credentialsOnDisk(old.dir)?.registered)))) {
      throw Object.assign(new Error('This WhatsApp account is already linked. Wait for it to reconnect if necessary.'), { statusCode: 409 });
    }
    if (old?.pairResult && !old.stopped && ownsCommand(old.pairGuard) && Date.now() < old.pairResult.issuedAt + codeLifetimeMs) return old.pairResult;
    const existingCount = [...entries.values()].filter((e) => e.number && ['pending', 'active'].includes(e.status)).length;
    if ((!old || !['pending', 'active'].includes(old.status)) && existingCount >= maxAccounts) {
      throw Object.assign(new Error('The linked-account limit has been reached.'), { statusCode: 409 });
    }
    if (old) await retire(old);
    assertCommand(guard);

    const attempt = crypto.randomBytes(12).toString('hex');
    // Baileys writes individual keys using the process umask. Restrict the
    // enclosing new directories even on hosts with a permissive default umask.
    fs.mkdirSync(path.join(linkedRoot, number, attempt), { recursive: true, mode: 0o700 });
    let claim = '';
    try { claim = String(opts.getClaim?.(number) || ''); } catch { /* no recoverable claim yet */ }
    writeRecord(number, { attempt, state: 'pending', ...(/^[a-f0-9]{64}$/.test(claim) ? { claim } : {}) });
    const entry = newEntry({ id: `linked:${number}`, number, attempt, state: 'pending', pairNumber: number });
    entry.pairGuard = guard;
    entries.set(entry.id, entry);
    const pending = waitForCode(entry);
    // Start in the background so the timeout also covers authentication and the
    // WebSocket handshake. A failed start retries until the request expires.
    void startEntry(entry);
    try { return await pending; }
    catch (err) {
      if (!entry.connected && !entry.auth?.creds?.registered && !entry.stopped) {
        mark(entry, 'expired');
        await retire(entry, 'Linking request ended');
      }
      throw err;
    }
  }

  function requestPair(rawNumber, options = {}) {
    const number = String(rawNumber || '').replace(/\D/g, '');
    if (!NUMBER_RE.test(number)) return Promise.reject(Object.assign(new Error('Enter a valid international WhatsApp number.'), { statusCode: 400 }));
    const guard = options?.canExecute === undefined ? () => true : options.canExecute;
    try { assertCommand(guard); } catch (err) { return Promise.reject(err); }
    if (flights.has(number)) return flights.get(number);
    const flight = doRequestPair(number, guard).finally(() => { if (flights.get(number) === flight) flights.delete(number); });
    flights.set(number, flight);
    return flight;
  }

  function status() {
    const accounts = [];
    for (const entry of entries.values()) {
      const number = entry.number || primaryNumber();
      if (!number) continue;
      let state = entry.connected ? 'connected' : entry.status === 'pending' ? 'awaiting_link' : entry.status === 'active' ? 'connecting' : entry.status;
      if (entry.number && entry.status === 'active' && !allowed(entry.number)) state = 'paused';
      const record = entry.number ? manifest.accounts[entry.number] : null;
      accounts.push({ number, state, ...(entry.attempt ? { sessionId: entry.attempt } : {}),
        ...(/^[a-f0-9]{64}$/.test(record?.claim || '') ? { claimToken: record.claim } : {}),
        ...(record?.linkedAt ? { linkedAt: record.linkedAt } : {}) });
    }
    const online = accounts.filter((a) => a.state === 'connected');
    return { connected: online.length > 0, primaryConnected: primary.connected, primaryNumber: primaryNumber(), botNumber: online[0]?.number || null, accounts };
  }

  // Revoke only the explicitly identified additional session. An old queued
  // unlink must never disconnect a newer pairing or the legacy primary socket.
  async function unlinkAccount(rawNumber, expectedSessionId, options = {}) {
    const guard = options?.canExecute;
    assertCommand(guard);
    const number = String(rawNumber || '').replace(/\D/g, '');
    const attempt = String(expectedSessionId || '');
    if (!NUMBER_RE.test(number) || !ATTEMPT_RE.test(attempt)) {
      throw Object.assign(new Error('Invalid linked session.'), { statusCode: 400 });
    }
    const entry = entries.get(`linked:${number}`);
    if (!entry || entry.attempt !== attempt || manifest.accounts[number]?.attempt !== attempt) {
      throw Object.assign(new Error('This linking session has changed. Refresh and try again.'), { statusCode: 409 });
    }
    if (entry.status === 'logged_out' || entry.status === 'expired') {
      assertCommand(guard);
      await retire(entry, 'Session unlinked');
      return { number, sessionId: attempt, unlinked: true };
    }
    if (!entry.connected || !entry.sock || typeof entry.sock.logout !== 'function') {
      throw Object.assign(new Error('The linked number is offline. Try again when it reconnects.'), { statusCode: 503 });
    }
    // Baileys sends WhatsApp's remove-companion-device request. Recheck the
    // exact command epoch immediately before making that irreversible request.
    // Once in flight it cannot be recalled; a lost lease suppresses its result.
    assertCommand(guard);
    await entry.sock.logout('Unlinked from the dashboard');
    mark(entry, 'logged_out');
    try { opts.onRevoked?.(`linked:${number}`, attempt); } catch { /* recovery retry is independent */ }
    await retire(entry, 'Session unlinked');
    return { number, sessionId: attempt, unlinked: true };
  }

  function refreshPermissions() {
    for (const entry of entries.values()) {
      // Cancel an unregistered member link as soon as its command loses the
      // lease. A later epoch on this same host must not revive the old request.
      if (entry.number && entry.status === 'pending' && entry.pairGuard && !entry.auth?.creds?.registered && !ownsCommand(entry.pairGuard)) {
        mark(entry, 'expired');
        void retire(entry, 'Linking command no longer owns the lease');
        continue;
      }
      // Legacy manifests did not record an ownership generation. Bind them once
      // to the current authoritative snapshot; future ownership changes never rebind.
      if (entry.number && manifest.accounts[entry.number] && !manifest.accounts[entry.number].claim && canPair(entry.number)) {
        let claim = ''; try { claim = String(opts.getClaim?.(entry.number) || ''); } catch { /* retry on next sync */ }
        if (/^[a-f0-9]{64}$/.test(claim)) {
          try { writeRecord(entry.number, { ...manifest.accounts[entry.number], claim }); opts.onClaimBound?.(entry.dir); } catch { /* preserve the old manifest */ }
        }
      }
      const existingClaim = entry.number && manifest.accounts[entry.number]?.claim;
      let currentClaim = '';
      try { if (entry.number) currentClaim = String(opts.getClaim?.(entry.number) || ''); } catch { /* keep session paused */ }
      if (opts.enforceClaims && existingClaim && /^[a-f0-9]{64}$/.test(currentClaim) && existingClaim !== currentClaim) {
        // A transferred/re-created portal claim must not inherit the prior
        // owner's WhatsApp socket. Preserve its files but allow a fresh link.
        mark(entry, 'expired');
        try { opts.onRevoked?.(`linked:${entry.number}`, entry.attempt); } catch { /* recovery retry is independent */ }
        void retire(entry, 'Number ownership changed');
        continue;
      }
      if (entry.connected && entry.sock && (!entry.number || allowed(entry.number))) sockets.setOnline(entry.id, entry.sock);
    }
    notify();
  }

  async function reconnectAll() {
    await Promise.all([...entries.values()].filter((e) => !e.stopped && (e === primary ? e.status !== 'logged_out' : e.status === 'active')).map(async (entry) => {
      entry.reconnector.reset();
      await startEntry(entry);
    }));
  }

  async function stop() {
    stopped = true;
    await Promise.all([...entries.values()].map((entry) => retire(entry, 'Service stopped')));
  }

  function primaryDeviceFingerprint() {
    return require('./failoverLease').fingerprintDevice(primary.auth?.creds || credentialsOnDisk(primaryDir));
  }

  return { start, stop, requestPair, unlinkAccount, status, primaryDeviceFingerprint, refreshPermissions, reconnectAll };
}

module.exports = { createSessionManager };
