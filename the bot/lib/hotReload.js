'use strict';

/**
 * ZaFar Bot — In-Process Runtime Hot Reload
 *
 * When `.restart` requests a reconnect, `reloadRuntime()`
 * purges cached command, engine, config, and handler modules from
 * `require.cache` and reloads them from disk before reconnecting WhatsApp,
 * without restarting the hosting server or killing PID 1.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Stateful singletons whose timers, queues, or sockets must stay intact
// (matched on the path relative to the bot root).
const PRESERVED = new Set([
  'lib/hotReload.js', 'lib/telemetry.js', 'lib/cleanup.js', 'lib/diskGuard.js', 'lib/tempManager.js',
  'lib/jobQueue.js', 'lib/persistentJobs.js', 'lib/jobDelivery.js', 'lib/accountSockets.js',
  'lib/safeLog.js', 'lib/jsonStore.js', 'lib/youtube/auth.js', 'lib/dbBackup.js',
  'gateway/guards.js',
]);

const listeners = new Set();
// This module survives hot reload, so concurrent .restart commands cannot
// bypass the guard when the command modules are reloaded from disk.
let restartInProgress = false;

function beginRestart() {
  if (restartInProgress) return false;
  restartInProgress = true;
  return true;
}

function finishRestart() {
  restartInProgress = false;
}

function onReload(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function shouldEvict(resolvedPath) {
  const rel = path.relative(ROOT, resolvedPath).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.startsWith('node_modules/')) return false;
  if (PRESERVED.has(rel)) return false;
  if (rel === 'config.js' || rel === 'gateway/handler.js' || rel === 'gateway/registry.js' || rel === 'gateway/ctx.js') return true;
  // gateway/sessions, gateway/users and gateway/dashboard hold sockets, timers and state.
  if (rel.startsWith('gateway/')) return false;
  if (rel.startsWith('commands/')) return true;
  if (rel.startsWith('lib/')) return true;
  return false;
}

function reloadRuntime() {
  try {
    require('./telemetry').flushNow();
  } catch { /* ignore */ }
  let evicted = 0;
  for (const key of Object.keys(require.cache)) {
    if (shouldEvict(key)) {
      delete require.cache[key];
      evicted += 1;
    }
  }

  const freshHandler = require(path.join(ROOT, 'gateway', 'handler.js'));
  if (!process.env.FAKE_YTDLP && !process.env.NM3U8DL_DISABLE_AUTOINSTALL) {
    try {
      require('./nm3u8dl').ensureInstalled({ quiet: true }).catch(() => {});
    } catch { /* ignore */ }
  }
  for (const fn of listeners) {
    try { fn(freshHandler); } catch { /* ignore */ }
  }
  return { ok: true, evicted, handler: freshHandler };
}

module.exports = {
  beginRestart,
  finishRestart,
  onReload,
  reloadRuntime,
};
