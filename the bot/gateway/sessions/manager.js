'use strict';

// Manages one legacy session and additional independent, persistent sessions.
// Dependencies are injected so the complete lifecycle can be tested offline.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createReconnector } = require('./reconnect');
const { readJsonSafe, writeJsonAtomic } = require('../../lib/jsonStore');
const sockets = require('../../lib/accountSockets');

// Disconnects WhatsApp or the network cause routinely; the session stays linked.
const TRANSIENT_CLOSE_CODES = new Set([408, 428, 500, 503, 504, 515]);
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
  // Leave most of the 20-second process shutdown budget for encrypted backup.
  const unlinkShutdownTimeoutMs = Math.max(1, Math.min(8000, Number(opts.unlinkShutdownTimeoutMs) || 2000));
  const retirementShutdownTimeoutMs = Math.max(1, Math.min(8000, Number(opts.retirementShutdownTimeoutMs) || 2000));
  const log = opts.log || require('../../lib/logger')('sessions');
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
  const unlinks = new Map();
  let stopped = false;
  let stopPromise = null;
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
      stopped: false, starting: null, requestStarted: false, pairResult: null,
      waiters: [], expiryTimer: null, seen: new Map(), credentialWrites: new Set(), retryNoticeAt: 0,
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
    // A creds.update may have been accepted just before this socket stopped.
    // Finish those writes before shutdown or replacing the session directory.
    await Promise.allSettled([...entry.credentialWrites]);
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
      if (entry.number && !canPair(entry.number)) {
        throw Object.assign(new Error('Number is no longer enabled'), { statusCode: 403 });
      }
      const code = await sock.requestPairingCode(entry.pairNumber);
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
      settlePair(entry, Object.assign(new Error(err?.statusCode === 403
        ? 'This number is no longer enabled.'
        : 'WhatsApp could not issue a linking code. Please try again.'), { statusCode: err?.statusCode === 403 ? 403 : 502 }));
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
      const auth = await opts.loadAuthState(entry.dir);
      if (stopped || entry.stopped) return null;
      entry.auth = auth.state;
      const version = await opts.getVersion();
      if (stopped || entry.stopped) return null;
      const sock = opts.makeSocket({ auth: auth.state, version });
      sock.__sessionId = entry.id;
      sock.__sessionDir = entry.dir;
      sock.__accountNumber = entry.number;
      // Resolve the claim at dispatch time: legacy sessions may be bound after
      // this socket starts, and a transferred claim must never inherit usage.
      sock.__memberUsageScope = () => {
        const record = entry.number && manifest.accounts[entry.number];
        if (!record || record.attempt !== entry.attempt || !allowed(entry.number)) return null;
        return { number: entry.number, sessionId: entry.attempt, claimToken: record.claim };
      };
      sock.__canRespond = () => !stopped && (!entry.number || (
        entry.connected && entry.status === 'active' &&
        manifest.accounts[entry.number]?.attempt === entry.attempt && allowed(entry.number)
      ));
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
        const write = Promise.resolve().then(() => auth.saveCreds()).then(() => {
          if (entry.number && entry.auth?.creds?.registered && !entry.stopped) {
            mark(entry, 'active');
            if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
            entry.expiryTimer = null;
          }
        }).catch((err) => log.error(`Could not save WhatsApp credentials: ${err?.message || err}`));
        entry.credentialWrites.add(write);
        void write.then(() => entry.credentialWrites.delete(write), () => entry.credentialWrites.delete(write));
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
          entry.retryNoticeAt = 0;
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
            const delay = entry.reconnector.schedule();
            if (delay !== false) {
              const code = Number.isInteger(statusCode) ? statusCode : 'unknown';
              // Do not log the raw disconnect object: it can contain session details.
              const now = Date.now();
              const message = `WhatsApp connection closed (status ${code}); retrying in ${delay}ms.`;
              entry.drops = (entry.drops || []).filter((at) => now - at < 10 * 60_000);
              entry.drops.push(now);
              const quietFor5Min = !entry.retryNoticeAt || now - entry.retryNoticeAt >= 5 * 60_000;
              if (TRANSIENT_CLOSE_CODES.has(statusCode)) {
                // Network blips and WhatsApp-requested restarts (408, 428, 515, ...)
                // reconnect by themselves: keep them out of the console unless
                // they pile up, which means the host's network is unstable.
                if (entry.drops.length >= 5 && quietFor5Min) {
                  entry.retryNoticeAt = now;
                  log.warn(`WhatsApp connection is unstable: ${entry.drops.length} drops in 10 min (last status ${code}). Check the host's network.`);
                } else log.debug?.(message);
              } else if (quietFor5Min) {
                entry.retryNoticeAt = now;
                log.warn(message);
              } else log.debug?.(message);
            }
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
            // Approval or the socket can change before this microtask runs.
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

  async function doRequestPair(number) {
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
    if (old?.pairResult && !old.stopped && Date.now() < old.pairResult.issuedAt + codeLifetimeMs) return old.pairResult;
    const existingCount = [...entries.values()].filter((e) => e.number && ['pending', 'active'].includes(e.status)).length;
    if ((!old || !['pending', 'active'].includes(old.status)) && existingCount >= maxAccounts) {
      throw Object.assign(new Error('The linked-account limit has been reached.'), { statusCode: 409 });
    }
    if (old) await retire(old);
    // Retirement can await socket or credential I/O. Shutdown or an approval
    // change during that wait must not create a fresh generation afterwards.
    if (stopped) throw Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 });
    if (!canPair(number)) throw Object.assign(new Error('Approve and enable this number for linking.'), { statusCode: 403 });

    const attempt = crypto.randomBytes(12).toString('hex');
    // Baileys writes individual keys using the process umask. Restrict the
    // enclosing new directories even on hosts with a permissive default umask.
    fs.mkdirSync(path.join(linkedRoot, number, attempt), { recursive: true, mode: 0o700 });
    let claim = '';
    try { claim = String(opts.getClaim?.(number) || ''); } catch { /* no recoverable claim yet */ }
    writeRecord(number, { attempt, state: 'pending', ...(/^[a-f0-9]{64}$/.test(claim) ? { claim } : {}) });
    const entry = newEntry({ id: `linked:${number}`, number, attempt, state: 'pending', pairNumber: number });
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

  function requestPair(rawNumber) {
    if (stopped) return Promise.reject(Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 }));
    const number = String(rawNumber || '').replace(/\D/g, '');
    if (!NUMBER_RE.test(number)) return Promise.reject(Object.assign(new Error('Enter a valid international WhatsApp number.'), { statusCode: 400 }));
    if (flights.has(number)) return flights.get(number);
    const flight = doRequestPair(number).finally(() => { if (flights.get(number) === flight) flights.delete(number); });
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
    return { connected: online.length > 0, botNumber: online[0]?.number || null, accounts };
  }

  // Revoke only the explicitly identified additional session. An old queued
  // unlink must never disconnect a newer pairing or the legacy primary socket.
  async function doUnlinkAccount(rawNumber, expectedSessionId) {
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
      await retire(entry, 'Session unlinked');
      return { number, sessionId: attempt, unlinked: true };
    }
    if (!entry.connected || !entry.sock || typeof entry.sock.logout !== 'function') {
      throw Object.assign(new Error('The linked number is offline. Try again when it reconnects.'), { statusCode: 503 });
    }
    // Baileys sends WhatsApp's remove-companion-device request. Do not claim
    // success, remove approval, or delete credentials when that request fails.
    await entry.sock.logout('Unlinked from the dashboard');
    mark(entry, 'logged_out');
    try { opts.onRevoked?.(`linked:${number}`, attempt); } catch { /* recovery retry is independent */ }
    await retire(entry, 'Session unlinked');
    return { number, sessionId: attempt, unlinked: true };
  }

  function unlinkAccount(rawNumber, expectedSessionId) {
    if (stopped) return Promise.reject(Object.assign(new Error('WhatsApp service is stopping.'), { statusCode: 503 }));
    const number = String(rawNumber || '').replace(/\D/g, '');
    const attempt = String(expectedSessionId || '');
    const key = `${number}:${attempt}`;
    if (unlinks.has(key)) return unlinks.get(key).operation;
    const operation = doUnlinkAccount(rawNumber, expectedSessionId);
    const item = { number, attempt, operation };
    unlinks.set(key, item);
    const forget = () => { if (unlinks.get(key) === item) unlinks.delete(key); };
    void operation.then(forget, forget);
    return operation;
  }

  function refreshPermissions() {
    for (const entry of entries.values()) {
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

  async function settleWithin(operations, timeoutMs) {
    if (!operations.length) return [];
    let timer;
    try {
      return await Promise.race([
        Promise.allSettled(operations),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      const errors = [];
      // Stop accepting new unlinks, but give accepted ones a short chance to
      // finish normally before retiring sockets and flushing recovery.
      const completed = await settleWithin([...unlinks.values()].map((item) => item.operation), unlinkShutdownTimeoutMs);
      if (!completed) {
        // The server may process logout even if its reply never arrives. Queue a
        // generation-scoped recovery revocation before backup stops so a late
        // success cannot resurrect that session. Local credentials are retained;
        // the unlink itself remains pending and is never reported as successful.
        for (const { number, attempt } of unlinks.values()) {
          // This attempt may have been replaced while logout was in flight.
          // A generation-scoped revocation is safe even after replacement.
          if (!NUMBER_RE.test(number) || !ATTEMPT_RE.test(attempt)) continue;
          try { opts.onRevoked?.(`linked:${number}`, attempt); }
          catch { log.warn('Could not queue recovery revocation for an incomplete WhatsApp unlink.'); }
        }
        errors.push(new Error('WhatsApp unlink did not finish before shutdown; its outcome is unknown and recovery revocation was requested. Local credentials were preserved.'));
      }
      // Baileys socket.end() is asynchronous too; a stuck close must not consume
      // the entire process budget and prevent other sessions from backing up.
      const retired = await settleWithin([...entries.values()].map((entry) => retire(entry, 'Service stopping')), retirementShutdownTimeoutMs);
      if (!retired) errors.push(new Error('A WhatsApp socket or credential write did not finish before shutdown.'));
      else for (const result of retired) if (result.status === 'rejected') errors.push(new Error('A WhatsApp session could not be retired.', { cause: result.reason }));
      if (errors.length) throw new AggregateError(errors, 'WhatsApp session shutdown was incomplete.');
    })();
    return stopPromise;
  }

  return { start, stop, requestPair, unlinkAccount, status, refreshPermissions, reconnectAll };
}

module.exports = { createSessionManager };
