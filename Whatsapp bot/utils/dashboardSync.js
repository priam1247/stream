/**
 * ZaFar Bot — Outbound HTTPS Dashboard Sync (`POST /api/bot/sync`)
 *
 * Works cleanly behind Hydrodactyl / Pterodactyl NAT with ZERO open ports:
 *   1. Pushes live heartbeat ("last seen Xs ago", WhatsApp socket state, disk MB)
 *   2. Pushes unsynced WhatsApp `.allow` numbers up to Cloudflare D1 and pulls
 *      versioned `whitelist.json` deltas down atomically via `accessControl.js`
 *   3. Claims queued `pair` and `restart` commands from Cloudflare D1 and reports
 *      the 8-character pairing code back immediately
 *   4. Signs every request with `HMAC-SHA256` + timestamp + random nonce
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { readWL, writeWL } = require('./accessControl');
const { inspectDisk } = require('./diskSpace');
const { panelRestart } = require('./panelClient');
const jobQueue = require('./jobQueue');
const telemetry = require('./telemetry');
const log = require('./logger')('dashboardSync');

const memberCommandPolicy = require('./memberCommandPolicy');
const WL_FILE = path.join(__dirname, '..', 'database', 'whitelist.json');
const BOT_BOOT_AT = Date.now();

let botVersion = '';
try {
  botVersion = require('../package.json').version || '';
} catch {
  /* ignore */
}

let activeController = null;

function cleanDigits(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

function buildSignedHeaders(token, _method, _urlPath, bodyText = '') {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig =
    'sha256=' +
    crypto
      .createHmac('sha256', token)
      .update(`${ts}.${nonce}.${bodyText}`)
      .digest('hex');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Bot-Timestamp': ts,
    'X-Bot-Nonce': nonce,
    'X-Bot-Signature': sig,
  };
}

function collectUnsyncedLocalUsers(wlFile = WL_FILE) {
  const current = readWL({ force: true, filePath: wlFile });
  const list = Array.isArray(current?.users) ? current.users : [];
  const out = [];
  for (const u of list) {
    const num = cleanDigits(u?.number);
    if (num.length < 7 || num.length > 15) continue;
    const isUnsyncedLocal =
      !u.syncedToPortal && (!u.addedBy || u.addedBy === 'whatsapp');
    if (isUnsyncedLocal && u.enabled !== false) {
      out.push({
        number: num,
        label: String(u.label || 'Added via WhatsApp .allow'),
      });
    }
  }
  return out;
}

function applyWhitelistSnapshot(users, wlFile = WL_FILE) {
  if (!Array.isArray(users)) return false;
  const current = readWL({ force: true, filePath: wlFile });
  const existingByNum = new Map();
  for (const u of Array.isArray(current.users) ? current.users : []) {
    const num = cleanDigits(u?.number);
    if (num) existingByNum.set(num, u);
  }

  // Portal snapshot is authoritative while preserving any LID `alt` aliases learned in WhatsApp
  const remoteMap = new Map();
  for (const raw of users) {
    const num = cleanDigits(raw?.number);
    if (num.length < 7 || num.length > 15) continue;
    const prev = existingByNum.get(num);
    remoteMap.set(num, {
      number: num,
      ...(Array.isArray(prev?.alt) && prev.alt.length ? { alt: prev.alt } : {}),
      label: String(raw?.label || prev?.label || ''),
      addedBy: String(raw?.addedBy || prev?.addedBy || 'dashboard'),
      addedAt: Number(raw?.addedAt || prev?.addedAt || Date.now()),
      enabled: raw?.enabled !== false,
      pairAllowed: raw?.pairAllowed === true,
      backupClaim: crypto.createHash('sha256').update(JSON.stringify([raw?.claimId || raw?.addedAt || '', String(raw?.addedBy || '').toLowerCase()])).digest('hex'),
      syncedToPortal: true,
    });
  }

  // Keep brand-new `.allow` entries that haven't been pushed to the portal yet
  for (const [num, prev] of existingByNum.entries()) {
    if (!remoteMap.has(num) && !prev.syncedToPortal && (!prev.addedBy || prev.addedBy === 'whatsapp')) {
      remoteMap.set(num, prev);
    }
  }

  writeWL({ users: Array.from(remoteMap.values()) }, { filePath: wlFile });
  return true;
}

function startDashboardSync(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const wlFile = opts.wlFile || WL_FILE;
  const commandPolicy = opts.commandPolicy || memberCommandPolicy;
  const failover = opts.failover || null;

  const baseUrl = String(opts.dashboardUrl ?? env.DASHBOARD_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const token = String(
    opts.token ?? env.BOT_SYNC_TOKEN ?? env.ADMIN_DASHBOARD_TOKEN ?? '',
  ).trim();

  if (!baseUrl || !token) {
    return {
      enabled: false,
      stop() {},
      syncNow: async () => ({ ok: false, skipped: true }),
    };
  }

  const defaultIntervalMs = Math.max(
    2_000,
    Number(opts.intervalMs ?? env.DASHBOARD_SYNC_INTERVAL_MS ?? 10_000) || 10_000,
  );

  let stopped = false;
  let timer = null;
  let inFlight = false;
  let rerunImmediately = false;
  let lastWhitelistVersion = '';
  let hasWhitelist = false;
  let consecutiveFailures = 0;
  const pendingResults = [];

  const scheduleNext = (ms) => {
    if (stopped || opts.manualOnly) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runSyncTick();
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  async function executeCommand(cmd) {
    if (!cmd || typeof cmd.id !== 'string') return;
    const commandEpoch = failover ? failover.report().epoch : 0;
    if (failover && !commandEpoch) return;
    const stillOwnsCommand = () => !failover || (failover.canServe() && failover.report().epoch === commandEpoch);
    const reportResult = (result) => { if (stillOwnsCommand()) pendingResults.push(result); };
    try {
      if (cmd.type === 'pair') {
        const number = cleanDigits(cmd.payload?.number);
        if (number.length < 7 || number.length > 15) {
          throw new Error('Invalid phone number in pairing command.');
        }
        if (Number(cmd.expiresAt) && Date.now() > Number(cmd.expiresAt)) {
          throw new Error('This linking request has expired. Please try again.');
        }
        // Never re-enable a number from a stale queued request. The latest
        // dashboard snapshot must still explicitly allow it.
        if (!readWL({ force: true, filePath: wlFile }).users.some((user) => String(user.number) === number && (user.enabled !== false || user.pairAllowed === true))) {
          throw new Error('This number is no longer allowed to link.');
        }
        if (typeof opts.requestPairing !== 'function') {
          throw new Error('Linking is not available on this service.');
        }
        const res = await opts.requestPairing(number);
        reportResult({
          id: cmd.id,
          ok: true,
          result: {
            code: res.code,
            expiresInSeconds: res.expiresInSeconds || 60,
            issuedAt: res.issuedAt || Date.now(),
          },
        });
        return;
      }

      if (cmd.type === 'unlink') {
        const number = cleanDigits(cmd.payload?.number);
        const sessionId = String(cmd.payload?.sessionId || '');
        const owner = String(cmd.payload?.owner || '').trim().toLowerCase();
        const claimKey = String(cmd.payload?.claimKey || '');
        if (!/^\d{7,15}$/.test(number) || !/^[a-f0-9]{24}$/.test(sessionId) || !owner || !claimKey) {
          throw new Error('Invalid unlink request.');
        }
        if (Number(cmd.expiresAt) && Date.now() > Number(cmd.expiresAt)) {
          throw new Error('This unlink request has expired.');
        }
        // The latest snapshot must still assign the session to this member.
        const expectedClaim = crypto.createHash('sha256').update(JSON.stringify([claimKey, owner])).digest('hex');
        const authorized = readWL({ force: true, filePath: wlFile }).users.some((user) =>
          String(user.number) === number && String(user.addedBy || '').toLowerCase() === owner && user.backupClaim === expectedClaim);
        if (!authorized) throw new Error('This number no longer belongs to that account.');
        if (typeof opts.unlinkAccount !== 'function') throw new Error('Unlinking is not available on this service.');
        const result = await opts.unlinkAccount(number, sessionId);
        reportResult({ id: cmd.id, ok: true, result });
        return;
      }

      if (cmd.type === 'restart') {
        reportResult({
          id: cmd.id,
          ok: true,
          result: { restarting: true },
        });
        setTimeout(async () => {
          if (!stillOwnsCommand()) return;
          const panelRes = await panelRestart();
          if (!panelRes.ok && typeof opts.requestRestart === 'function') {
            await opts.requestRestart();
          }
        }, 600).unref?.();
        return;
      }

      reportResult({
        id: cmd.id,
        ok: false,
        error: `Unsupported command type: ${String(cmd.type)}`,
      });
    } catch (err) {
      reportResult({
        id: cmd.id,
        ok: false,
        error: err?.message || 'Command failed on the service',
      });
    }
  }

  async function runSyncTick() {
    if (stopped) return { ok: false, stopped: true };
    if (inFlight) {
      rerunImmediately = true;
      return { ok: true, coalesced: true };
    }

    inFlight = true;
    let batchResults = [];
    try {
      const status =
        typeof opts.getStatus === 'function'
          ? opts.getStatus() || {}
          : { connected: false, botNumber: null };

      let diskUsedMB;
      let diskBudgetMB;
      try {
        const d = inspectDisk();
        diskUsedMB = Math.round(d.folderUsedMB);
        diskBudgetMB = Math.round(d.budgetMB);
      } catch {
        /* non-fatal */
      }

      const stats = telemetry.snapshot();
      let queueLight = 0;
      let queueHeavy = 0;
      try {
        const q = jobQueue.stats();
        queueLight = (q.light?.active || 0) + (q.light?.queued || 0);
        queueHeavy = (q.heavy?.active || 0) + (q.heavy?.queued || 0);
      } catch {
        /* non-fatal */
      }

      const localUsers = collectUnsyncedLocalUsers(wlFile);
      if (failover && !failover.canServe()) pendingResults.length = 0;
      const failoverReport = failover?.report();
      batchResults = pendingResults.splice(0, pendingResults.length);
      const bodyObj = {
        connected: Boolean(status.connected),
        botNumber: status.botNumber || null,
        ...(Array.isArray(status.accounts) ? { accounts: status.accounts } : {}),
        botName: config.botName,
        version: botVersion,
        uptimeSeconds: Math.floor((Date.now() - BOT_BOOT_AT) / 1000),
        commandsTotal: stats.commandsTotal,
        downloadsSuccess: stats.downloadsSuccess,
        failedTotal: stats.failedTotal,
        ramUsedMB: stats.ramUsedMB,
        queueLight,
        queueHeavy,
        diskUsedMB,
        diskBudgetMB,
        whitelistVersion: lastWhitelistVersion,
        commandPolicyVersion: commandPolicy.version(),
        ...(failoverReport ? { failover: { ...failoverReport, primaryConnected: status.primaryConnected === true,
          deviceFingerprint: status.primaryDeviceFingerprint || '' } } : {}),
        ...(typeof opts.getBackupStatus === 'function' ? { sessionBackup: opts.getBackupStatus() } : {}),
        ...(localUsers.length ? { localUsers } : {}),
        completedResults: batchResults,
      };

      const bodyText = JSON.stringify(bodyObj);
      const urlPath = '/api/bot/sync';

      const headers = buildSignedHeaders(token, 'POST', urlPath, bodyText);
      const leaseRequest = failover?.startRequest();
      const res = await fetchImpl(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (failover && [401, 403, 409].includes(res.status)) failover.revoke();
        if (batchResults.length && (!failover || (failover.canServe() && failover.report().epoch === failoverReport.epoch))) {
          pendingResults.unshift(...batchResults);
        }
        consecutiveFailures++;
        const backoff = Math.min(60_000, defaultIntervalMs * Math.pow(1.6, consecutiveFailures));
        if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
          log.warn(`Dashboard sync answered HTTP ${res.status}; retrying in ${Math.round(backoff / 1000)}s`);
        }
        inFlight = false;
        scheduleNext(backoff);
        return { ok: false, status: res.status };
      }

      const data = await res.json().catch(() => ({}));
      if (stopped) return { ok: false, stopped: true };
      consecutiveFailures = 0;
      // A missing, late, denied or mismatched response immediately fences this
      // node. The standby may still receive the current permission snapshots.
      const mayExecute = failover ? failover.accept(data.failover, leaseRequest) : true;

      let policyConfirmed = false;
      if (Array.isArray(data.disabledMemberCommands) && typeof data.commandPolicyVersion === 'string') {
        commandPolicy.apply(data.disabledMemberCommands, data.commandPolicyVersion);
        policyConfirmed = true;
      }
      if (data.whitelistChanged && Array.isArray(data.users)) {
        applyWhitelistSnapshot(data.users, wlFile);
        if (typeof data.whitelistVersion === 'string') {
          lastWhitelistVersion = data.whitelistVersion;
          hasWhitelist = true;
        }
        try { opts.onWhitelistChanged?.(); } catch { /* non-fatal */ }
      } else if (typeof data.whitelistVersion === 'string' && !lastWhitelistVersion) {
        lastWhitelistVersion = data.whitelistVersion;
      }
      // After restart, do not authorize linked members on an old disk cache
      // until this process has received both current portal snapshots.
      if (hasWhitelist && policyConfirmed) {
        try { opts.onPermissionsReady?.(); } catch { /* non-fatal */ }
      }

      const commands = mayExecute && Array.isArray(data.commands) ? data.commands : [];
      // A slow linking handshake must not block heartbeats or another account's
      // code. Report each result as soon as it is available.
      for (const cmd of commands) {
        void executeCommand(cmd).finally(() => {
          if (stopped) return;
          if (inFlight) rerunImmediately = true;
          else scheduleNext(150);
        });
      }

      inFlight = false;

      if (pendingResults.length > 0 || rerunImmediately) {
        rerunImmediately = false;
        scheduleNext(150);
      } else {
        const nextMs = Math.max(
          2_000,
          Math.min(60_000, Number(data.nextPollMs) || defaultIntervalMs),
        );
        scheduleNext(nextMs);
      }

      return { ok: true, commandsExecuted: commands.length };
    } catch (err) {
      if (batchResults.length) pendingResults.unshift(...batchResults);
      consecutiveFailures++;
      const backoff = Math.min(60_000, defaultIntervalMs * Math.pow(1.6, consecutiveFailures));
      if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
        log.warn(`Dashboard sync unreachable (${err.message || err}); retrying in ${Math.round(backoff / 1000)}s`);
      }
      inFlight = false;
      scheduleNext(backoff);
      return { ok: false, error: err.message || String(err) };
    }
  }

  const controller = {
    enabled: true,
    dashboardUrl: baseUrl,
    syncNow: () => runSyncTick(),
    stop() {
      stopped = true;
      failover?.revoke();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };

  if (!opts.manualOnly) {
    activeController = controller;
    scheduleNext(250);
  }

  return controller;
}

function triggerImmediateSync() {
  if (activeController && activeController.enabled) {
    void activeController.syncNow();
  }
}

module.exports = {
  startDashboardSync,
  triggerImmediateSync,
  buildSignedHeaders,
  applyWhitelistSnapshot,
  collectUnsyncedLocalUsers,
};
