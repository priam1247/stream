'use strict';

// Authenticated, encrypted recovery of Baileys' multi-file state. This module
// never logs session data and never replaces an existing local session.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildSignedHeaders } = require('./dashboardSync');
const { readJsonSafe, writeJsonAtomic } = require('./jsonStore');

const MAX_PLAIN = 3_000_000;
const MAX_FILES = 6000;
const MAX_CIPHERTEXT = 1_000_000;
const FILE_RE = /^[A-Za-z0-9_@.+=-]{1,200}\.json$/;
const ATTEMPT_RE = /^[a-f0-9]{24}$/;
const NUMBER_RE = /^\d{7,15}$/;
const STALE_PRIMARY = Symbol('stale primary generation');

function parseKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('SESSION_BACKUP_KEY must be a stable base64-encoded 32-byte key.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('SESSION_BACKUP_KEY must be a stable base64-encoded 32-byte key.');
  return key;
}
function seal(payload, key, slot, generation) {
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > MAX_PLAIN) throw new Error('Session backup exceeds the size limit.');
  const compressed = zlib.gzipSync(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${slot}\0${generation}`));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const result = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
  if (result.length > MAX_CIPHERTEXT) throw new Error('Encrypted session backup exceeds the size limit.');
  return result;
}
function open(ciphertext, key, slot, generation) {
  if (typeof ciphertext !== 'string' || ciphertext.length > MAX_CIPHERTEXT) throw new Error('Encrypted session backup is invalid.');
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Encrypted session backup is invalid.');
  const iv = Buffer.from(parts[1], 'base64'); const tag = Buffer.from(parts[2], 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Encrypted session backup is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`${slot}\0${generation}`)); decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]);
  const data = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: MAX_PLAIN }).toString('utf8'));
  validatePayload(data, slot, generation);
  return data;
}
function validatePayload(data, slot, generation) {
  if (!data || data.version !== 1 || data.slot !== slot || data.generation !== generation || !data.files ||
      typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('Session backup structure is invalid.');
  const entries = Object.entries(data.files);
  if (!entries.length || entries.length > MAX_FILES || !Object.hasOwn(data.files, 'creds.json')) throw new Error('Session backup files are invalid.');
  for (const [name, content] of entries) {
    if (!FILE_RE.test(name) || name.includes('..') || typeof content !== 'string' || content.length > MAX_PLAIN) throw new Error('Session backup file is invalid.');
    JSON.parse(content);
  }
  if (!JSON.parse(data.files['creds.json'])?.registered) throw new Error('Session backup is not registered.');
  if (slot !== 'primary' && !/^[a-f0-9]{64}$/.test(data.claimToken || '')) throw new Error('Session backup ownership is invalid.');
}
function localFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((item) => item.isFile() && item.name.endsWith('.json'));
}
function collectFiles(dir) {
  const files = {};
  let total = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of entries) {
    if (!item.name.endsWith('.json')) continue;
    if (!item.isFile() || item.isSymbolicLink() || !FILE_RE.test(item.name) || item.name.includes('..')) throw new Error('Session contains an unsafe file.');
    const full = path.join(dir, item.name);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_PLAIN) throw new Error('Session contains an unsafe file.');
    const text = fs.readFileSync(full, 'utf8');
    total += Buffer.byteLength(text); if (total > MAX_PLAIN) throw new Error('Session backup exceeds the size limit.');
    JSON.parse(text); files[item.name] = text;
    if (Object.keys(files).length > MAX_FILES) throw new Error('Session contains too many files.');
  }
  return files;
}

function createSessionBackup(opts = {}) {
  const key = parseKey(opts.key);
  const root = path.resolve(opts.sessionDir || 'session');
  const statePath = path.resolve(opts.statePath || path.join('database', 'session-backup-state.json'));
  const log = opts.log || console;
  const fetchImpl = opts.fetchImpl || fetch;
  const baseUrl = String(opts.dashboardUrl || '').replace(/\/+$/, '');
  const token = String(opts.token || '');
  let status = key ? 'starting' : 'disabled';
  let lastBackupAt = null;
  const revisions = new Map(); const remote = new Map(); const conflicts = new Set(); const failures = new Set();
  const pending = new Map(); const retryTimers = new Map(); const locks = new Map(); const uploadDirs = new Map(); const stoppedGenerations = new Set();
  const authWrites = new Map(); const shutdownDirty = new Set(); const finalSnapshots = new Map();
  let stopped = false; let stopping = false; let stopPromise = null; let warnedAfterStop = false; let wakeShutdown = null;
  const signalShutdown = () => { const wake = wakeShutdown; wakeShutdown = null; wake?.(); };
  const markShutdownDirty = (dir) => { shutdownDirty.add(dir); signalShutdown(); };
  if (key && (!baseUrl.startsWith('https://') || !token)) throw new Error('Session recovery requires HTTPS dashboard sync and a service token.');
  const validRevocation = (item) => item && (item.slot === 'primary' || /^linked:\d{7,15}$/.test(item.slot)) && ATTEMPT_RE.test(item.generation || '');
  const stateRead = readJsonSafe(statePath, { defaultValue: { version: 1, slots: {} }, validate: (v) => v && v.version === 1 && v.slots && typeof v.slots === 'object' && !Array.isArray(v.slots) &&
    (v.revocations === undefined || (Array.isArray(v.revocations) && v.revocations.length <= 10000 && v.revocations.every(validRevocation))) });
  if (key && !stateRead.ok) throw new Error('Session backup index is unreadable; local data was preserved.');
  const localState = stateRead.ok ? stateRead.data : { version: 1, slots: {} };
  localState.revocations ||= [];
  for (const item of localState.revocations) stoppedGenerations.add(`${item.slot}:${item.generation}`);
  const persist = () => writeJsonAtomic(statePath, localState);
  function descriptor(dir) {
    const relative = path.relative(root, path.resolve(dir));
    if (!relative) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(root, 'creds.json'), 'utf8'));
        const identity = [creds.registrationId ?? null, creds.me?.id || '', creds.signedIdentityKey?.public || null];
        if (!creds.registered || (!identity[0] && !identity[1] && !identity[2])) return null;
        const generation = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
        return { slot: 'primary', generation, dir: root };
      } catch { return null; }
    }
    const parts = relative.split(path.sep);
    if (parts.length !== 3 || parts[0] !== 'linked' || !NUMBER_RE.test(parts[1]) || !ATTEMPT_RE.test(parts[2])) return null;
    return { slot: `linked:${parts[1]}`, generation: parts[2], dir: path.resolve(dir), number: parts[1] };
  }
  async function request(data) {
    const body = JSON.stringify(data);
    const res = await fetchImpl(`${baseUrl}/api/bot/session-backups`, {
      method: 'POST', headers: buildSignedHeaders(token, 'POST', '/api/bot/session-backups', body), body,
      signal: AbortSignal.timeout(12000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 409 ? 'The encrypted backup changed; manual review is required.' : `Session backup service returned HTTP ${res.status}.`);
      err.statusCode = res.status; throw err;
    }
    return json;
  }
  function locked(dir, work) {
    const previous = locks.get(dir) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(dir, next);
    next.finally(() => { if (locks.get(dir) === next) locks.delete(dir); signalShutdown(); }).catch(() => {});
    return next;
  }
  function installFiles(target, files) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(target, name), value, { flag: 'wx', mode: 0o600 });
  }
  async function restore() {
    if (!key) { log.warn('Encrypted session recovery is off: set SESSION_BACKUP_KEY and configure durable dashboard storage.'); return; }
    // Never restore stale data while a locally recorded logout is waiting to
    // reach the portal. If the portal is down, startup retries without writes.
    for (const item of [...localState.revocations]) await flushRevocation(item.slot, item.generation);
    const records = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const response = await request({ action: 'list', ...(after ? { after } : {}) });
      if (!Array.isArray(response.records) || response.records.length > 100) throw new Error('Session backup index is invalid.');
      records.push(...response.records);
      if (response.records.length < 100) break;
      const next = response.records[response.records.length - 1]?.slot;
      if (!next || next <= after || page === 19) throw new Error('Session backup index is too large or invalid.');
      after = next;
    }
    const retrieved = [];
    for (const record of records) {
      if (!record || !(record.slot === 'primary' || /^linked:\d{7,15}$/.test(record.slot)) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('Session backup index is invalid.');
      revisions.set(record.slot, record.revision); remote.set(record.slot, record);
      if (!record.revoked && Number.isSafeInteger(record.updatedAt)) lastBackupAt = Math.max(lastBackupAt || 0, record.updatedAt);
      if (record.revoked) continue;
      try {
        const result = await request({ action: 'get', slot: record.slot });
        if (!result.record || result.record.revision !== record.revision || result.record.generation !== record.generation) throw new Error('Session backup changed during recovery.');
        // Authenticate every eligible record before any local writes. A wrong key
        // must never replace the only good copy with freshly generated state.
        const payload = open(result.record.ciphertext, key, record.slot, record.generation);
        if (record.slot !== 'primary' && payload.claimToken !== result.record.claimToken) throw new Error('Session backup ownership changed.');
        retrieved.push({ record, payload });
      } catch (err) {
        if (err.statusCode === 403 || err.statusCode === 404) continue; // blocked, removed or new owner
        throw new Error('Session recovery could not authenticate the backup. Check the key and service; local files were preserved.');
      }
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const primary = retrieved.find((item) => item.record.slot === 'primary');
    if (primary && !localFiles(root)) {
      installFiles(root, primary.payload.files);
      localState.slots.primary = { generation: primary.record.generation, revision: primary.record.revision }; persist();
    } else if (primary && localState.slots.primary?.revision !== primary.record.revision) conflicts.add('primary');

    const linkedRoot = path.join(root, 'linked');
    const links = retrieved.filter((item) => item.record.slot.startsWith('linked:'));
    if (links.length && !fs.existsSync(linkedRoot)) {
      const staging = path.join(root, `.recovery-${crypto.randomBytes(8).toString('hex')}`);
      fs.mkdirSync(staging, { mode: 0o700 });
      const manifest = { version: 1, accounts: {} };
      try {
        for (const { record, payload } of links) {
          const number = record.slot.slice(7);
          if (!NUMBER_RE.test(number) || !ATTEMPT_RE.test(record.generation)) throw new Error('Invalid linked backup.');
          installFiles(path.join(staging, number, record.generation), payload.files);
          manifest.accounts[number] = { attempt: record.generation, state: 'active', claim: payload.claimToken, ...(Number.isSafeInteger(payload.linkedAt) && payload.linkedAt > 0 ? { linkedAt: payload.linkedAt } : {}) };
        }
        writeJsonAtomic(path.join(staging, 'accounts.json'), manifest);
        if (fs.existsSync(linkedRoot)) throw new Error('Local linked sessions appeared during recovery.');
        fs.renameSync(staging, linkedRoot);
        for (const { record } of links) localState.slots[record.slot] = { generation: record.generation, revision: record.revision };
        persist();
      } catch (err) { fs.rmSync(staging, { recursive: true, force: true }); throw err; }
    } else if (links.length) {
      for (const { record } of links) if (localState.slots[record.slot]?.revision !== record.revision) conflicts.add(record.slot);
    }
    status = conflicts.size ? 'conflict' : 'ready';
    log.info(conflicts.size ? 'Session recovery preserved local files; a backup conflict needs review.' : 'Encrypted session recovery is ready.');
  }
  function schedule(dir) {
    if (!key || stopped || stopping) return;
    const desc = descriptor(dir); if (!desc || stoppedGenerations.has(`${desc.slot}:${desc.generation}`)) return;
    // An old generation's timer or revocation must not cancel a replacement.
    const id = `${desc.slot}:${desc.generation}`;
    if (pending.has(id)) return;
    const timer = setTimeout(() => {
      const queued = pending.get(id); if (!queued) return;
      pending.delete(id);
      // Identity can change during the debounce interval. Resolve it again
      // before snapshotting instead of uploading under the captured generation.
      const current = descriptor(queued.dir);
      if (!current || stoppedGenerations.has(`${current.slot}:${current.generation}`)) return;
      void snapshot(current).catch(() => {
        failures.add(current.slot); status = 'error';
        log.warn('Encrypted session backup could not be saved; local sessions were preserved.');
        schedule(queued.dir);
      });
    }, Math.max(100, Number(opts.delayMs) || 15000));
    timer.unref?.(); pending.set(id, { timer, dir: desc.dir, slot: desc.slot });
  }
  async function snapshot(desc) {
    const upload = locked(`upload:${desc.slot}`, async () => {
    if (conflicts.has(desc.slot) || stoppedGenerations.has(`${desc.slot}:${desc.generation}`)) { status = 'conflict'; return; }
    const prior = remote.get(desc.slot);
    if (prior?.revoked && prior.generation === desc.generation) return;
    const payload = await locked(desc.dir, async () => {
      if (desc.number) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'linked', 'accounts.json'), 'utf8'));
        const record = manifest?.accounts?.[desc.number];
        if (!record || record.attempt !== desc.generation || record.state !== 'active' || !/^[a-f0-9]{64}$/.test(record.claim || '')) return null;
        return { version: 1, slot: desc.slot, generation: desc.generation, claimToken: record.claim, linkedAt: record.linkedAt, files: collectFiles(desc.dir) };
      }
      // The primary identity can change while an earlier write is still in
      // flight. Never upload its new credentials under an old generation.
      const current = descriptor(desc.dir);
      if (!current || current.slot !== desc.slot || current.generation !== desc.generation) return STALE_PRIMARY;
      return { version: 1, slot: desc.slot, generation: desc.generation, files: collectFiles(desc.dir) };
    });
    if (payload === STALE_PRIMARY) return STALE_PRIMARY;
    if (!payload || stopped || stoppedGenerations.has(`${desc.slot}:${desc.generation}`)) return;
    let creds;
    try { creds = JSON.parse(payload.files['creds.json'] || '{}'); } catch { throw new Error('Local session credentials are invalid.'); }
    if (!creds.registered) return; // A new, not-yet-linked socket has nothing to back up.
    validatePayload(payload, desc.slot, desc.generation);
    const ciphertext = seal(payload, key, desc.slot, desc.generation);
    const result = await request({ action: 'put', slot: desc.slot, generation: desc.generation, claimToken: payload.claimToken || 'primary', revision: revisions.get(desc.slot) || 0, ciphertext });
    if (!Number.isSafeInteger(result.revision)) throw new Error('Invalid backup acknowledgement.');
    revisions.set(desc.slot, result.revision); remote.set(desc.slot, { slot: desc.slot, generation: desc.generation, claimToken: payload.claimToken || 'primary', revision: result.revision, revoked: false });
    localState.slots[desc.slot] = { generation: desc.generation, revision: result.revision }; persist();
    failures.delete(desc.slot);
    lastBackupAt = Date.now(); status = conflicts.size ? 'conflict' : 'ready';
    });
    uploadDirs.set(upload, desc.dir);
    void upload.then(() => uploadDirs.delete(upload), () => uploadDirs.delete(upload));
    const result = await upload;
    if (result === STALE_PRIMARY && !stopped) {
      // Retry with a fresh descriptor only after the old upload lock releases.
      if (stopping) markShutdownDirty(desc.dir); else schedule(desc.dir);
    }
    return result;
  }
  async function flushRevocation(slot, generation) {
    await request({ action: 'revoke', slot, generation });
    const result = await request({ action: 'meta', slot });
    const record = result.record;
    if (record) { revisions.set(slot, record.revision); remote.set(slot, record); }
    // A delayed logout from an older generation cannot erase local metadata
    // for a newer session in the same slot.
    if (localState.slots[slot]?.generation === generation) delete localState.slots[slot];
    localState.revocations = localState.revocations.filter((item) => item.slot !== slot || item.generation !== generation);
    persist();
    failures.delete(`revoke:${slot}:${generation}`);
    if (status === 'error' && !failures.size && !localState.revocations.length) status = conflicts.size ? 'conflict' : 'ready';
  }
  async function revoke(slot, generation) {
    if (!key || stopped) return;
    if (slot === 'primary' && generation === 'primary') generation = descriptor(root)?.generation || '';
    if (!validRevocation({ slot, generation })) { failures.add('revocation:unknown'); status = 'error'; log.warn('The revoked session generation could not be identified for recovery.'); return; }
    const id = `${slot}:${generation}`;
    stoppedGenerations.add(id);
    if (pending.has(id)) { clearTimeout(pending.get(id).timer); pending.delete(id); }
    if (!localState.revocations.some((item) => item.slot === slot && item.generation === generation)) {
      localState.revocations.push({ slot, generation });
      try { persist(); } catch { status = 'error'; log.warn('Could not persist the recovery revocation queue. Check disk space.'); }
    }
    return locked(`revoke:${id}`, async () => {
      if (stopped || !localState.revocations.some((item) => item.slot === slot && item.generation === generation)) return;
      try {
        await flushRevocation(slot, generation);
        if (retryTimers.has(id)) { clearTimeout(retryTimers.get(id)); retryTimers.delete(id); }
      } catch {
        failures.add(`revoke:${id}`); status = 'error'; log.warn('Session revocation could not yet be synchronized to encrypted recovery; retrying.');
        if (!stopped && !stopping && !retryTimers.has(id)) {
          const timer = setTimeout(() => { retryTimers.delete(id); void revoke(slot, generation); }, 30000);
          timer.unref?.(); retryTimers.set(id, timer);
        }
      }
    });
  }
  async function stop({ flush = false } = {}) {
    if (stopPromise) return stopPromise;
    stopping = true;
    for (const item of pending.values()) shutdownDirty.add(item.dir);
    for (const dir of uploadDirs.values()) shutdownDirty.add(dir);
    for (const dir of authWrites.values()) shutdownDirty.add(dir);
    for (const id of locks.keys()) if (path.isAbsolute(id)) shutdownDirty.add(id);
    for (const item of pending.values()) clearTimeout(item.timer);
    for (const timer of retryTimers.values()) clearTimeout(timer);
    pending.clear(); retryTimers.clear();
    if (!flush || !key) stopped = true;
    stopPromise = (async () => {
      if (flush && key) {
        const finalFailures = new Map();
        // Keep accepting local writes until a synchronous, quiescent boundary.
        // A slow upload or revocation must not block another slot's late write.
        while (true) {
          for (const dir of shutdownDirty) {
            if (finalSnapshots.has(dir)) continue; // coalesce writes per directory
            shutdownDirty.delete(dir);
            const desc = descriptor(dir);
            if (!desc) continue;
            const snapshotDone = snapshot(desc).then(() => {
              if (!failures.has(desc.slot)) finalFailures.delete(dir);
            }, (err) => {
              finalFailures.set(dir, new Error('Final encrypted session snapshot failed.', { cause: err }));
              failures.add(desc.slot); status = 'error';
              log.warn('Final encrypted session backup could not be saved; local sessions were preserved.');
            });
            finalSnapshots.set(dir, snapshotDone);
            const forget = () => { if (finalSnapshots.get(dir) === snapshotDone) finalSnapshots.delete(dir); signalShutdown(); };
            void snapshotDone.then(forget, forget);
          }
          if (!shutdownDirty.size && !finalSnapshots.size && !locks.size && !authWrites.size) { stopped = true; break; }
          // Each accepted write, completed lock, or completed snapshot wakes this
          // loop; it need not wait for unrelated network requests to finish.
          await new Promise((resolve) => { wakeShutdown = resolve; });
        }
        if (finalFailures.size) throw new AggregateError([...finalFailures.values()], 'Encrypted session recovery did not flush completely.');
      } else {
        while (locks.size || authWrites.size) await Promise.allSettled([...locks.values(), ...authWrites.keys()]);
      }
    })();
    return stopPromise;
  }
  function writeAuth(dir, work) {
    if (stopped && key && !warnedAfterStop) {
      warnedAfterStop = true; failures.add('late-write'); status = 'error';
      log.warn('Credentials changed after recovery stopped; the local write is preserved but the backup may be stale.');
    }
    const write = locked(dir, work).then((result) => {
      // A write accepted before or during stop can finish after an earlier
      // snapshot. Requeue its directory even though normal scheduling is closed.
      if (stopping && !stopped && key) markShutdownDirty(dir);
      else schedule(dir);
      return result;
    }, (err) => {
      // A failed write may have changed some local files before failing.
      if (stopping && !stopped && key) markShutdownDirty(dir);
      throw err;
    });
    authWrites.set(write, dir); signalShutdown();
    const forget = () => { authWrites.delete(write); signalShutdown(); };
    void write.then(forget, forget);
    return write;
  }
  async function wrapAuth(loadAuthState, dir) {
    const auth = await loadAuthState(dir);
    const resolvedDir = path.resolve(dir);
    const set = auth.state.keys.set.bind(auth.state.keys); const save = auth.saveCreds.bind(auth);
    auth.state.keys.set = (data) => writeAuth(resolvedDir, () => set(data));
    auth.saveCreds = () => writeAuth(resolvedDir, () => save());
    schedule(resolvedDir);
    return auth;
  }
  function recoveryStatus() {
    const effective = conflicts.size ? 'conflict' : (failures.size || localState.revocations.length) ? 'error' : status;
    if (!key || effective === 'starting') return { state: effective, lastBackupAt };
    try {
      const slots = [];
      const primary = descriptor(root);
      if (primary) slots.push({ ...primary, claim: 'primary' });
      const manifestFile = path.join(root, 'linked', 'accounts.json');
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (!manifest?.accounts || typeof manifest.accounts !== 'object') throw new Error('Invalid manifest');
        for (const [number, record] of Object.entries(manifest.accounts)) {
          if (record?.state !== 'active' || !NUMBER_RE.test(number) || !ATTEMPT_RE.test(record.attempt || '')) continue;
          slots.push({ slot: `linked:${number}`, generation: record.attempt, claim: record.claim || '', number, dir: path.join(root, 'linked', number, record.attempt) });
        }
      }
      const backedUp = slots.filter((item) => {
        const backup = remote.get(item.slot); const local = localState.slots[item.slot];
        const eligible = !item.number || !opts.isEligible || opts.isEligible(item.number, item.claim);
        return eligible && !conflicts.has(item.slot) && ![...pending.values()].some((queued) => queued.slot === item.slot) && !locks.has(`upload:${item.slot}`) && !locks.has(item.dir) &&
          !stoppedGenerations.has(`${item.slot}:${item.generation}`) && backup && !backup.revoked && backup.generation === item.generation &&
          backup.claimToken === item.claim && local?.generation === item.generation && local.revision === backup.revision;
      }).length;
      return { state: effective, lastBackupAt, sessions: slots.length, backedUp };
    } catch { return { state: 'error', lastBackupAt }; }
  }
  return { enabled: Boolean(key), restore, wrapAuth, revoke, schedule, stop, status: recoveryStatus, _snapshot: snapshot };
}
module.exports = { createSessionBackup, parseKey, seal, open, validatePayload };
