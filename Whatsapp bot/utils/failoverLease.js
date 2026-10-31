'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');

// This does not share WhatsApp credentials. Each host must be linked as its own
// device. The dashboard's D1 lease decides which device may serve commands.
const LEASE_TTL_MS = 30_000;
const SAFETY_MARGIN_MS = 2_000;

// Public identity keys differ for independently linked devices. Only a one-way
// digest is sent to the dashboard; private credentials never leave this host.
function fingerprintDevice(creds) {
  if (!creds?.registered) return null;
  try {
    const pub = creds.signedIdentityKey?.public;
    const bytes = Buffer.isBuffer(pub) || pub instanceof Uint8Array ? Buffer.from(pub)
      : pub?.type === 'Buffer' && Array.isArray(pub.data) ? Buffer.from(pub.data)
        : pub?.type === 'Buffer' && typeof pub.data === 'string' ? Buffer.from(pub.data, 'base64') : null;
    return bytes?.length === 32 ? crypto.createHash('sha256').update(bytes).digest('hex') : null;
  } catch { return null; }
}

function createFailoverLease(role, options = {}) {
  if (role !== 'xs' && role !== 'botkeep') throw new Error('Failover role must be xs or botkeep.');
  const instance = options.instance || crypto.randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(instance)) throw new Error('Invalid failover instance identity.');
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const wallNow = options.wallNow || (() => Date.now());
  let active = false;
  let epoch = 0;
  let greatestEpoch = 0;
  let monoDeadline = 0;
  let wallDeadline = 0;
  let timer = null;

  function notify(value) { try { options.onChange?.(value); } catch { /* status listeners are non-fatal */ } }
  function revoke() {
    if (timer) clearTimeout(timer);
    timer = null;
    epoch = 0;
    monoDeadline = 0;
    wallDeadline = 0;
    if (active) { active = false; notify(false); }
  }
  function canServe() {
    // The monotonic deadline protects against a wall-clock setback; the wall
    // deadline also protects against a suspended VM's monotonic clock pausing.
    if (active && (monotonicNow() >= monoDeadline || wallNow() >= wallDeadline)) revoke();
    return active;
  }
  function startRequest() { return { mono: monotonicNow(), wall: wallNow() }; }
  function accept(grant, started) {
    canServe();
    if (!grant || grant.granted !== true || grant.role !== role || grant.instance !== instance ||
        !Number.isSafeInteger(grant.epoch) || grant.epoch < 1 || grant.epoch < greatestEpoch ||
        grant.ttlMs !== LEASE_TTL_MS || !started || !Number.isFinite(started.mono) || !Number.isFinite(started.wall)) {
      revoke();
      return false;
    }
    const duration = LEASE_TTL_MS - SAFETY_MARGIN_MS;
    const nextMono = started.mono + duration;
    const nextWall = started.wall + duration;
    if (monotonicNow() >= nextMono || wallNow() >= nextWall) { revoke(); return false; }
    epoch = grant.epoch;
    greatestEpoch = Math.max(greatestEpoch, epoch);
    monoDeadline = nextMono;
    wallDeadline = nextWall;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { canServe(); }, Math.max(1, nextMono - monotonicNow()));
    timer.unref?.();
    if (!active) { active = true; notify(true); }
    return true;
  }
  return {
    role, instance, startRequest, accept, canServe, revoke,
    report: () => ({ role, instance, epoch: canServe() ? epoch : 0 }),
  };
}

module.exports = { createFailoverLease, fingerprintDevice };
