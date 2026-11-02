'use strict';

/**
 * gateway/index.js — boot: sessions → registry → router → dashboard.
 *
 * Boot order matters for the failure behaviour the spec asks for:
 *   1. registry loads FIRST, so a broken command folder is marked ❌ and the bot
 *      still starts.
 *   2. sessions start one at a time; a bad session is logged and skipped.
 *   3. the router is wired to the sockets.
 *   4. the dashboard sync (if configured) starts last.
 */

const fs = require('fs');
const config = require('./config');
const registry = require('./registry');
const status = require('./status');
const router = require('./router');
const store = require('./users/store');
const { SessionManager } = require('./sessions/manager');
const { Dashboard } = require('./dashboard');
const { gatewayLog } = require('./log');
const { paths, commandTmpRoot } = require('../lib/paths');
const { ensureDir } = require('../lib/fsutil');

function ensureTree() {
  for (const dir of [
    paths.storageCore, paths.numbers, paths.commandData, paths.tmp,
    paths.backups, paths.sessionsLinked, paths.logs,
  ]) {
    ensureDir(dir);
  }
}

function purgeTmp() {
  // A killed child never reaches its own cleanup; anything left here at boot is
  // debris from a previous crash. Job folders are disposable by definition.
  if (!fs.existsSync(paths.tmp)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(paths.tmp)) {
    if (!/^[a-z0-9_]{1,40}$/.test(name)) continue;
    const dir = commandTmpRoot(name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      gatewayLog.warn('could not purge command tmp', { command: name, error: err.message });
    }
  }
  return removed;
}

async function boot({ withSessions = true } = {}) {
  ensureTree();
  gatewayLog.info('boot', { botName: config.botName, prefix: config.prefix, node: process.version });

  const purged = purgeTmp();
  if (purged) gatewayLog.info('purged stale command tmp folders', { count: purged });

  const owner = store.readOwner();
  if (!owner) {
    gatewayLog.warn('no owner set — run `npm run add-owner -- <number>`; every command is refused until then');
  } else {
    gatewayLog.info('owner', { number: owner });
  }

  const loaded = registry.load();
  // Apply persisted ⛔ states after the registry knows which commands exist.
  require('./admin').applyDisabledAtBoot();
  gatewayLog.info('registry loaded', { loaded: loaded.loaded, failed: loaded.failed });
  for (const [folder, problems] of Object.entries(loaded.errors)) {
    gatewayLog.error('command skipped', { command: folder, problems });
  }

  const manager = new SessionManager({
    onMessage: async (number, sock, message) => {
      await router.handle({ number, sock, message });
    },
  });

  // Let admin commands see live sessions and request pairing.
  router.setSessionSnapshot(() => manager.list());
  router.setRequestPairing(async (number) => {
    const { requestCode } = require('./sessions/pairing');
    return requestCode(manager, number);
  });

  if (withSessions) {
    const sessions = await manager.startAll();
    gatewayLog.info('sessions', { count: sessions.length, states: sessions.map((s) => `${s.number}:${s.state}`) });
  }

  const dashboard = new Dashboard({
    getSessions: () => manager.list(),
    requestPairing: async (number) => {
      const { requestCode, instructions } = require('./sessions/pairing');
      const { code } = await requestCode(manager, number);
      gatewayLog.info('pairing requested by dashboard', { number, instructions: instructions(code) });
    },
  });
  dashboard.start();

  return { manager, dashboard, loaded, owner };
}

if (require.main === module) {
  const shutdown = async (signal, ctx) => {
    gatewayLog.info('shutdown', { signal });
    try { ctx?.dashboard?.stop(); } catch { /* already stopped */ }
    try { await ctx?.manager?.stopAll(); } catch { /* already stopped */ }
    process.exit(0);
  };

  let ctx = null;
  boot()
    .then((result) => { ctx = result; })
    .catch((err) => {
      gatewayLog.error('boot failed', { error: err.stack || err.message });
      process.exit(1);
    });

  process.on('SIGINT', () => { void shutdown('SIGINT', ctx); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM', ctx); });

  process.on('unhandledRejection', (err) => {
    gatewayLog.error('unhandled rejection', { error: err?.stack || String(err) });
  });
  process.on('uncaughtException', (err) => {
    gatewayLog.error('uncaught exception', { error: err?.stack || String(err) });
  });
}

module.exports = { boot, ensureTree, purgeTmp, status, registry };
