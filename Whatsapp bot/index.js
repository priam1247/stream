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

// The Scribd search + download panel is a separate server in `working scribd/`.
// This bot does not start it; the dashboard talks to it independently.

const { formatArgs, redactArg } = require('./utils/safeLog');
const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
const { startDiskGuard } = require('./utils/diskGuard');
initializeTempSystem();
let cleanupSafe = false;
try {
  require('./utils/jobDelivery').protectPendingFiles();
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
let handler = require('./handler');
const { onReload, reloadRuntime } = require('./utils/hotReload');
onReload((freshHandler) => { handler = freshHandler; });
const { isSystemJid } = require('./utils/jid');
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

const { createSessionManager } = require('./utils/sessionManager');
const { readWL } = require('./utils/accessControl');
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
  const { getFailoverRole } = require('./utils/failoverConfig');
  const failoverRole = getFailoverRole(process.env, config.admin);
  let sessions;
  const failover = failoverRole ? require('./utils/failoverLease').createFailoverLease(failoverRole, {
    onChange: (active) => {
      console.log(`WhatsApp failover: ${failoverRole} ${active ? 'active' : 'standby'}.`);
      sessions?.refreshPermissions();
    },
  }) : null;
  let permissionsSynced = !portalSyncConfigured;
  const { createSessionBackup } = require('./utils/sessionBackup');
  const backup = createSessionBackup({ sessionDir: config.sessionName, dashboardUrl: config.admin?.dashboardUrl,
    token: config.admin?.syncToken, key: process.env.SESSION_BACKUP_KEY,
    isEligible: (number, claim) => readWL().users.some((user) => String(user.number) === number && user.backupClaim === claim && (user.enabled !== false || user.pairAllowed === true)) });
  // Do not create a fresh manifest or credentials when recovery is unavailable.
  await backup.restore();
  sessions = createSessionManager({
  sessionDir: config.sessionName,
  pairNumber: config.pairNumber,
  canServe: () => !failover || failover.canServe(),
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
    getMessage: async () => undefined,
  }),
  isAllowed: (number) => permissionsSynced && readWL().users.some((user) => String(user.number) === number && user.enabled !== false),
  canPair: (number) => permissionsSynced && readWL().users.some((user) => String(user.number) === number && (user.enabled !== false || user.pairAllowed === true)),
  enforceClaims: portalSyncConfigured,
  getClaim: (number) => readWL().users.find((user) => String(user.number) === number && (user.enabled !== false || user.pairAllowed === true))?.backupClaim || '',
  isSystemJid,
  onMessage: (sock, msg) => handler.handleMessage(sock, msg),
  onOpen: (sock) => { handler.onSocketOpen?.(sock); console.log('WhatsApp connection is ready.'); },
  onRevoked: (slot, generation) => { void backup.revoke(slot, generation); },
  onClaimBound: (dir) => backup.schedule(dir),
  onStatusChange: () => { try { require('./utils/dashboardSync').triggerImmediateSync(); } catch { /* ignore */ } },
  onQr: (qr) => { console.log('Scan this QR code with WhatsApp:'); qrcode.generate(qr, { small: true }); },
  // A code requested from the dashboard is never printed to the server logs.
  onConsoleCode: (code) => {
    console.log(`Linking code: ${code}`);
    console.log('WhatsApp → Linked devices → Link a device → Link with phone number instead.');
  },
});

// ── Dashboard Outbound HTTPS Sync + Optional Inbound API ─────────────────────
// Recommended on Hydrodactyl / Pterodactyl: set DASHBOARD_URL + BOT_SYNC_TOKEN
// (with ADMIN_API_ENABLED=false so no open port is needed). The bot pushes live
// heartbeats, pulls versioned whitelist deltas, and picks up pairing requests.
const { startSessionServices } = require('./utils/serviceStartup');
await startSessionServices(sessions, async function startDashboardBridge() {
  let sync; let api;
  try {
  const admin = config.admin || {};
  const { startAdminApi } = require('./utils/adminApi');
  const { startDashboardSync } = require('./utils/dashboardSync');

  sync = startDashboardSync({
    dashboardUrl: admin.dashboardUrl,
    token: admin.syncToken,
    intervalMs: admin.syncIntervalMs,
    failover,
    getStatus: () => ({ ...sessions.status(), ...(failover ? { primaryDeviceFingerprint: sessions.primaryDeviceFingerprint() } : {}) }),
    getBackupStatus: () => backup.status(),
    requestPairing: (number) => sessions.requestPair(number),
    unlinkAccount: (number, sessionId) => sessions.unlinkAccount(number, sessionId),
    onWhitelistChanged: () => sessions.refreshPermissions(),
    onPermissionsReady: () => { if (!permissionsSynced) { permissionsSynced = true; sessions.refreshPermissions(); } },
    requestRestart: async () => {
      console.log('Dashboard requested a reload and reconnection.');
      try {
        const res = reloadRuntime();
        console.log(`Reloaded ${res.evicted} module(s) from disk.`);
      } catch (err) {
        console.error('Reload warning:', err?.message || err);
      }
      await sessions.reconnectAll();
    },
  });

  // A direct per-host bridge could bypass the shared command lease.
  if (admin.apiEnabled && admin.token && !failover) {
    api = startAdminApi({
      port: admin.port,
      token: admin.token,
      allowedOrigins: admin.corsOrigins || [],
      hooks: {
        status: async () => {
          const { readWL } = require('./utils/accessControl');
          return {
            ...sessions.status(),
            botName: config.botName,
            members: readWL().users.filter((u) => u.enabled !== false).length,
          };
        },
        requestPair: (number) => sessions.requestPair(number),
        unlinkAccount: (number, sessionId) => sessions.unlinkAccount(number, sessionId),
        whitelistChanged: () => sessions.refreshPermissions(),
      },
    });
    console.log(`Dashboard API active (port ${admin.port}${sync.enabled ? ', outbound sync enabled' : ''}).`);
  } else if (sync.enabled) {
    console.log('Dashboard outbound sync active.');
  } else {
    console.log('Dashboard sync is off (set DASHBOARD_URL + BOT_SYNC_TOKEN to connect).');
  }
  } catch (error) {
    sync?.stop();
    if (api) await api.stop().catch(() => {});
    throw error;
  }
}, () => backup.stop());

try { require('./utils/logger').banner([
  'WhatsApp Service',
  `prefix   ${config.prefix}`,
  `node     ${process.version}`,
]); } catch (error) { console.warn('Startup banner warning:', error.message); }

// yt-dlp looks after itself: install/repair at boot, verify every 30 minutes,
// and re-download the binary when a download reports it as missing or broken.
(() => {
  try {
  const YT = require('./utils/youtubedl');
  const ffmpeg = require('./utils/ffmpeg');
  const nm3u8dl = require('./utils/nm3u8dl');
  console.log(ffmpeg.works() ? `🎞️ ffmpeg  ${ffmpeg.version() || 'ready'}` : '🎞️ ffmpeg  ❌ not available');
  YT.scheduleAutoUpdate();
  YT.healthCheck().then((cmd) => {
    console.log(cmd ? `🎬 yt-dlp  ${YT.version() || 'ready'}` : '🎬 yt-dlp  ❌ not available (will retry while running)');
  }).catch(() => {});
  YT.startWatchdog({ everyMinutes: 30 });
  nm3u8dl.ensureInstalled().then((bin) => {
    console.log(
      bin
        ? `⚡ N_m3u8DL-RE  ${nm3u8dl.version() || 'ready'} (${nm3u8dl.threadCount()}t)`
        : '⚡ N_m3u8DL-RE  unavailable (falling back to ffmpeg/native HLS)'
    );
  }).catch(() => {});
  } catch (error) { console.warn('Media helper startup warning:', error.message); }
})();

}
function retryServiceStart() {
  startService().catch((err) => {
    console.error('Session recovery/startup unavailable; local files were preserved. Check the backup key, dashboard and durable storage.', err.message);
    setTimeout(retryServiceStart, 30000);
  });
}
retryServiceStart();
// Handle process termination
process.on('uncaughtException', (err) => {
  // Handle ENOSPC errors gracefully without crashing
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.error('⚠️ ENOSPC Error: No space left on device. Attempting cleanup...');
    if (cleanupSafe) {
      const { cleanupOldFiles } = require('./utils/cleanup');
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
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.warn('⚠️ ENOSPC Error in promise: No space left on device. Attempting cleanup...');
    if (cleanupSafe) {
      const { cleanupOldFiles } = require('./utils/cleanup');
      cleanupOldFiles();
      console.warn('⚠️ Cleanup completed. The service may need more disk space.');
    } else {
      console.warn('Automatic cleanup remains disabled to protect pending downloads.');
    }
    return; // Don't crash, just log and continue
  }

  // Don't spam console with rate limit errors
  if (err.message && err.message.includes('rate-overlimit')) {
    console.warn('⚠️ Rate limit reached. Please slow down your requests.');
    return;
  }
  console.error('Unhandled Rejection:', err);
});

module.exports = {};
