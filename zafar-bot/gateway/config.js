'use strict';

/**
 * gateway/config.js — environment only.
 *
 * There is no built-in owner and no built-in admin list. The old bot shipped
 * privileged numbers as defaults in config.js; that is removed on purpose
 * (see MIGRATION_REPORT.md). Run `npm run add-owner -- <number>` once.
 */

const fs = require('fs');
const path = require('path');
const { paths } = require('../lib/paths');

function loadDotEnv(file = paths.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const num = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const env = process.env;

const config = {
  botName: env.BOT_NAME || 'WhatsApp',
  prefix: env.PREFIX || '.',
  timezone: env.TZ || 'Africa/Blantyre',

  pairNumber: env.PAIR_NUMBER || '',
  maxLinkedAccounts: num(env.MAX_LINKED_ACCOUNTS, 20),

  logLevel: String(env.LOG_LEVEL || 'info').toLowerCase(),

  dashboard: {
    url: (env.DASHBOARD_URL || '').replace(/\/+$/, ''),
    token: env.BOT_SYNC_TOKEN || '',
    intervalMs: num(env.DASHBOARD_SYNC_INTERVAL_MS, 10_000),
    get enabled() {
      return Boolean(this.url && this.token);
    },
  },

  media: {
    timeoutMs: num(env.XJX_MEDIA_TIMEOUT_MS, 60_000),
    apisSupremeKey: env.XJX_APISSUPREME_API_KEY || '',
    knightbotKey: env.XJX_KNIGHTBOT_API_KEY || '',
  },

  // Feature-specific settings do not live here. A command reads its own
  // environment variables in its own config.js; a shared config that knows about
  // one feature is exactly the coupling this rebuild removes.

  // No movie/series settings here. Size, runtime and quality limits are declared
  // in each command's command.json and handed to the engine by engine-bridge.js;
  // TMDB is read by the engine itself. A shared config duplicating a command's
  // limits is the two-sources-of-truth problem this rebuild removes.
};

/** Filled in at boot by gateway/index.js once the registry is loaded. */
config.registry = null;

module.exports = config;
module.exports.loadDotEnv = loadDotEnv;
