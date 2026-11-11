/**
 * WhatsApp MD Bot - Main Entry Point
 */

// Keep .env, session/ and other cwd-relative runtime files with the bot even
// when the entry point is started from the repository root or a panel script.
process.chdir(__dirname);

// Baileys/jsdom and the built-in SQLite job store need a current Node runtime.
// Give panel users an actionable message before a dependency crashes on load.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(`Node.js ${process.versions.node} is too old. Use Node.js 22.13 or newer (Node 22 LTS is recommended).`);
  process.exit(1);
}

// A fresh install (or a panel reinstall) has no node_modules yet. Say that in
// one line instead of letting the first require() throw a 40-line stack.
(function checkDependencies() {
  try {
    require.resolve('@whiskeysockets/baileys');
  } catch {
    console.error('❌ Dependencies are missing — run `npm install` in this folder.');
    console.error('   Make sure the panel\'s Startup Command runs it, e.g. `npm install && node index.js`.');
    process.exit(1);
  }
})();

// Production by default: skips the pino-pretty worker thread + dev overhead.
// Override with NODE_ENV=development when debugging locally.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// The Scribd search + download panel is a separate server in `scribd/`.
// This bot does not start it; the dashboard talks to it independently.

const { formatArgs, redactArg, safeText } = require('./lib/safeLog');
const { initializeTempSystem } = require('./lib/tempManager');
const { startCleanup, stopCleanup } = require('./lib/cleanup');
const { startDiskGuard, stopDiskGuard } = require('./lib/diskGuard');
initializeTempSystem();
let cleanupSafe = false;
try {
  require('./lib/jobDelivery').protectPendingFiles();
  cleanupSafe = true;
} catch (err) {
  console.error('Could not protect pending downloads; automatic cleanup is disabled until restart:', err.message);
}
if (cleanupSafe) {
  startCleanup();
  startDiskGuard();
}
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const forbiddenPatternsConsole = [
  'closing session',
  'closing open session',
  'sessionentry',
  'prekey bundle',
  'pendingprekey',
  '_chains',
  'registrationid',
  'currentratchet',
  'chainkey',
  'ratchet',
  'signal protocol',
  'ephemeralkeypair',
  'indexinfo',
  'basekey'
];

console.log = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleLog.apply(console, args.map(redactArg));
  }
};

console.error = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleError.apply(console, args.map(redactArg));
  }
};

console.warn = (...args) => {
  const message = formatArgs(args);
  if (!forbiddenPatternsConsole.some(pattern => message.includes(pattern))) {
    originalConsoleWarn.apply(console, args.map(redactArg));
  }
};

// Now safe to load libraries
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const config = require('./config');
let handler = require('./gateway/handler');
const { onReload } = require('./lib/hotReload');
onReload((freshHandler) => { handler = freshHandler; });
const { isSystemJid } = require('./lib/jid');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Custom Pino logger with suppression for Baileys noise
const createSuppressedLogger = (level = 'silent') => {
  const forbiddenPatterns = [
    'closing session',
    'closing open session',
    'sessionentry',
    'prekey bundle',
    'pendingprekey',
    '_chains',
    'registrationid',
    'currentratchet',
    'chainkey',
    'ratchet',
    'signal protocol',
    'ephemeralkeypair',
    'indexinfo',
    'basekey',
    'sessionentry',
    'ratchetkey'
  ];

  let logger;
  try {
    logger = pino({
      level,
      // Fallback transport without pino-pretty (in case not installed)
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname'
        }
      },
      customLevels: {
        trace: 0,
        debug: 1,
        info: 2,
        warn: 3,
        error: 4,
        fatal: 5
      },
      // Redact sensitive fields
      redact: ['registrationId', 'ephemeralKeyPair', 'rootKey', 'chainKey', 'baseKey']
    });
  } catch (err) {
    // Fallback to basic pino without transport
    logger = pino({ level });
  }

  // Wrap log methods to filter
  const originalInfo = logger.info.bind(logger);
  logger.info = (...args) => {
    const msg = formatArgs(args);
    if (!forbiddenPatterns.some(pattern => msg.includes(pattern))) {
      originalInfo(...args);
    }
  };
  logger.debug = () => { }; // Fully disable debug
  logger.trace = () => { }; // Fully disable trace
  return logger;
};

// Preserve the existing primary credentials and bootstrap older session strings
// only when there is no credential file. Never overwrite an existing session.
(function bootstrapLegacySession() {
  if (!config.sessionID || !config.sessionID.startsWith('ZaFarBot!')) return;
  try {
    const encoded = config.sessionID.slice(config.sessionID.indexOf('!') + 1).replace('...', '');
    if (!encoded) throw new Error('Empty session data');
    const data = zlib.gunzipSync(Buffer.from(encoded, 'base64'));
    const folder = path.resolve(config.sessionName);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'creds.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    console.error('Could not load the supplied session data:', err.message);
  }
})();

const { createSessionManager } = require('./gateway/sessions/manager');
const { readWL, isApprovedUser, canPairUser } = require('./gateway/users/access');
const FALLBACK_VERSION = [2, 3000, 1033141466];
let versionPromise = null;
let cachedVersion = null;
let versionValidUntil = 0;
function getWebVersion() {
  if (cachedVersion && Date.now() < versionValidUntil) return Promise.resolve(cachedVersion);
  if (!versionPromise) {
    versionPromise = new Promise((resolve) => {
      let done = false;
      const finish = (version, isFallback = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cachedVersion = version;
        // Retry failed lookups sooner, but coalesce simultaneous connections.
        versionValidUntil = Date.now() + (isFallback ? 5 * 60_000 : 60 * 60_000);
        versionPromise = null;
        resolve(version);
      };
      const timer = setTimeout(() => finish(FALLBACK_VERSION, true), 8000);
      timer.unref?.();
      Promise.resolve().then(() => fetchLatestWaWebVersion())
        .then((result) => result?.version ? finish(result.version) : finish(FALLBACK_VERSION, true))
        .catch(() => finish(FALLBACK_VERSION, true));
    });
  }
  return versionPromise;
}

async function startService() {
  const portalSyncConfigured = Boolean(config.admin?.dashboardUrl && config.admin?.syncToken);
  let permissionsSynced = !portalSyncConfigured;
  const { createSessionBackup } = require('./gateway/sessions/backup');
  const backup = createSessionBackup({ sessionDir: config.sessionName, dashboardUrl: config.admin?.dashboardUrl,
    token: config.admin?.syncToken, key: process.env.SESSION_BACKUP_KEY,
    isEligible: (number, claim) => readWL().users.some((user) => String(user.number) === number && user.backupClaim === claim && canPairUser(user)) });
  // Do not create a fresh manifest or credentials when recovery is unavailable.
  await backup.restore();
  const sessions = createSessionManager({
  sessionDir: config.sessionName,
  pairNumber: config.pairNumber,
  maxAccounts: Number(process.env.MAX_LINKED_ACCOUNTS || 20),
  loggedOutCode: DisconnectReason.loggedOut,
  loadAuthState: (dir) => backup.wrapAuth(useMultiFileAuthState, dir),
  getVersion: getWebVersion,
  makeSocket: ({ auth, version }) => makeWASocket({
    version,
    logger: createSuppressedLogger('silent'),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth,
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 20_000, // frequent pings keep idle panel/mobile networks from dropping the socket
    connectTimeoutMs: 60_000,
    getMessage: async () => undefined,
  }),
  isAllowed: (number) => permissionsSynced && readWL().users.some((user) => String(user.number) === number && isApprovedUser(user)),
  canPair: (number) => permissionsSynced && readWL().users.some((user) => String(user.number) === number && canPairUser(user)),
  enforceClaims: portalSyncConfigured,
  getClaim: (number) => readWL().users.find((user) => String(user.number) === number && canPairUser(user))?.backupClaim || '',
  isSystemJid,
  onMessage: (sock, msg) => handler.handleMessage(sock, msg),
  onOpen: (sock) => {
    handler.onSocketOpen?.(sock);
    // Say "ready" once per account; later reconnects are routine and stay quiet.
    const who = String(sock?.__accountNumber || sock?.__sessionId || 'primary');
    if (!globalThis.__waOpened) globalThis.__waOpened = new Set();
    if (!globalThis.__waOpened.has(who)) { globalThis.__waOpened.add(who); console.log('WhatsApp connection is ready.'); }
    else require('./lib/logger')('sessions').debug('WhatsApp reconnected.');
  },
  onRevoked: (slot, generation) => { void backup.revoke(slot, generation); },
  onClaimBound: (dir) => backup.schedule(dir),
  onStatusChange: () => { try { require('./gateway/dashboard/sync').triggerImmediateSync(); } catch { /* ignore */ } },
  onQr: (qr) => { console.log('Scan this QR code with WhatsApp:'); qrcode.generate(qr, { small: true }); },
  // A code requested from the dashboard is never printed to the server logs.
  onConsoleCode: (code) => {
    console.log(`Linking code: ${code}`);
    console.log('WhatsApp → Linked devices → Link a device → Link with phone number instead.');
  },
});

// ── Dashboard outbound HTTPS sync ───────────────────────────────────────────
// Set DASHBOARD_URL + BOT_SYNC_TOKEN on the service. The bot pushes live
// heartbeats, pulls versioned whitelist deltas, and picks up pairing requests.
// Nothing listens for the dashboard: there is no inbound admin API or port.
const { startSessionServices } = require('./gateway/sessions/startup');
const bridge = await startSessionServices(sessions, async function startDashboardBridge() {
  let sync;
  try {
  const admin = config.admin || {};
  const { startDashboardSync } = require('./gateway/dashboard/sync');

  sync = startDashboardSync({
    dashboardUrl: admin.dashboardUrl,
    token: admin.syncToken,
    intervalMs: admin.syncIntervalMs,
    getStatus: () => sessions.status(),
    getBackupStatus: () => backup.status(),
    requestPairing: (number) => sessions.requestPair(number),
    unlinkAccount: (number, sessionId) => sessions.unlinkAccount(number, sessionId),
    onWhitelistChanged: () => sessions.refreshPermissions(),
    onPermissionsReady: () => { if (!permissionsSynced) { permissionsSynced = true; sessions.refreshPermissions(); } },
  });

  if (sync.enabled) {
    console.log('Dashboard outbound sync active.');
  } else {
    console.log('Dashboard sync is off (set DASHBOARD_URL + BOT_SYNC_TOKEN to connect).');
  }
  } catch (error) {
    sync?.stop();
    throw error;
  }
  return { sync };
}, () => backup.stop());

try { require('./lib/logger').banner([
  'WhatsApp Service',
  `prefix   ${config.prefix}`,
  `node     ${process.version}`,
]); } catch (error) { console.warn('Startup banner warning:', error.message); }

// Report the optional local engine without installing or repairing it at boot.
(() => {
  try {
  const YT = require('./lib/youtube/youtubedl');
  const ffmpeg = require('./lib/ffmpeg');
  const nm3u8dl = require('./lib/nm3u8dl');
  const mediaLog = require('./lib/logger')('media');
  if (!ffmpeg.works()) mediaLog.warn('ffmpeg unavailable; some media conversions will not work.');
  else mediaLog.debug(`ffmpeg ${ffmpeg.version() || 'ready'}`);
  YT.healthCheck().then((cmd) => {
    mediaLog.debug(cmd ? `yt-dlp ${YT.version() || 'ready'}` : 'optional yt-dlp unavailable');
  }).catch(() => {});
  nm3u8dl.ensureInstalled().then((bin) => {
    mediaLog.debug(bin ? `N_m3u8DL-RE ${nm3u8dl.version() || 'ready'}` : 'N_m3u8DL-RE unavailable; using HLS fallback');
  }).catch(() => {});
  } catch (error) { console.warn('Media helper startup warning:', error.message); }
})();

return { sessions, backup, ...bridge };
}

const { createServiceLifecycle, stopSessionServices } = require('./gateway/sessions/startup');
const lifecycle = createServiceLifecycle({
  start: startService,
  stop: stopSessionServices,
  onError: (err) => console.error('Session recovery/startup unavailable; local files were preserved. Check the backup key, dashboard and durable storage.', err?.message || err),
});

// This is a long-running service even when all sockets are disconnected and
// maintenance timers are unref'd. Stay available for dashboard pairing and
// retries until an explicit shutdown.
const serviceLifetime = setInterval(() => {}, 24 * 60 * 60 * 1000);

// Give accepted credential writes and encrypted backups a chance to finish on a
// normal panel stop. A hard kill or the timeout can still interrupt the backup;
// the local session files are never deleted.
let shutdownRequested = false;
function shutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`Stopping WhatsApp service (${signal}).`);
  stopCleanup();
  stopDiskGuard();
  let finished = false;
  let timer;
  const finish = (timedOut = false) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    clearInterval(serviceLifetime);
    if (timedOut) console.warn('Shutdown timed out; encrypted recovery may not have the latest changes. Local files were preserved.');
    try { require('./lib/telemetry').flushNow(); } catch { /* non-fatal */ }
    try { require('./lib/dbBackup').snapshot('shutdown'); } catch { /* non-fatal */ }
    process.exit(0);
  };
  timer = setTimeout(() => finish(true), 20_000);
  void lifecycle.shutdown().catch((err) => {
    console.warn('WhatsApp shutdown was incomplete.');
    // Normal Baileys noise filtering may suppress an entire error merely because
    // it mentions a closing session. Bypass that filter only for sanitized,
    // component-labelled shutdown diagnostics; never print raw session data.
    const failures = err instanceof AggregateError && Array.isArray(err.errors) ? err.errors : [err];
    const labels = new Set(['Dashboard sync shutdown failed', 'Dashboard API shutdown failed', 'WhatsApp sessions shutdown failed', 'Session backup shutdown failed']);
    for (const failure of failures) {
      const detail = safeText(failure);
      const lower = detail.toLowerCase();
      const sensitive = forbiddenPatternsConsole.some((pattern) => pattern !== 'closing session' && pattern !== 'closing open session' && lower.includes(pattern)) ||
        /\b(?:private|public|identity|signing|encryption|backup|chain|pre|base)[\s_-]*key\b|\b(?:buffer|uint8array)\b|[A-Za-z0-9+/]{40,}={0,2}/i.test(detail);
      if (!sensitive) {
        originalConsoleWarn.call(console, 'Shutdown detail:', detail);
        continue;
      }
      const label = labels.has(failure?.message) ? failure.message : 'WhatsApp shutdown component failed';
      const reason = lower.includes('closing open session') ? 'closing open session; ' : lower.includes('closing session') ? 'closing session; ' : '';
      originalConsoleWarn.call(console, 'Shutdown detail:', `${label}; ${reason}sensitive session details omitted.`);
    }
  }).finally(() => finish());
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
void lifecycle.start();
require('./lib/dbBackup').start(); // rotating backups of database/*.json
// Handle process termination
process.on('uncaughtException', (err) => {
  // Handle ENOSPC errors gracefully without crashing
  if (err?.code === 'ENOSPC' || err?.errno === -28 || err?.message?.includes('no space left on device')) {
    console.error('⚠️ ENOSPC Error: No space left on device. Attempting cleanup...');
    if (cleanupSafe) {
      const { cleanupOldFiles } = require('./lib/cleanup');
      cleanupOldFiles();
      console.warn('⚠️ Cleanup completed. The service may need more disk space.');
    } else {
      console.warn('Automatic cleanup remains disabled to protect pending downloads.');
    }
    return; // Don't crash, just log and continue
  }
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  // Handle ENOSPC errors gracefully
  if (err?.code === 'ENOSPC' || err?.errno === -28 || err?.message?.includes('no space left on device')) {
    console.warn('⚠️ ENOSPC Error in promise: No space left on device. Attempting cleanup...');
    if (cleanupSafe) {
      const { cleanupOldFiles } = require('./lib/cleanup');
      cleanupOldFiles();
      console.warn('⚠️ Cleanup completed. The service may need more disk space.');
    } else {
      console.warn('Automatic cleanup remains disabled to protect pending downloads.');
    }
    return; // Don't crash, just log and continue
  }

  // Don't spam console with rate limit errors
  if (err?.message?.includes('rate-overlimit')) {
    console.warn('⚠️ Rate limit reached. Please slow down your requests.');
    return;
  }
  console.error('Unhandled Rejection:', err);
});

module.exports = {};
