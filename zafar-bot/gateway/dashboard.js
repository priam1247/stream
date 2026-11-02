'use strict';

/**
 * gateway/dashboard.js — dashboard connection + sync.
 *
 * Deliberately one-way for access control: the bot REPORTs state (sessions,
 * status board, users) and ACCEPTs pairing requests. It does not accept a
 * whitelist snapshot. In the old bot `applyWhitelistSnapshot()` overwrote
 * whitelist.json, which made the dashboard a second writer of user data and
 * made per-number user lists impossible. That is removed (decision C in
 * MIGRATION_REPORT.md); users.json now has exactly one writer, store.js.
 *
 * If DASHBOARD_URL / BOT_SYNC_TOKEN are unset, sync is off and everything else
 * works exactly the same.
 */

const axios = require('axios');
const config = require('./config');
const registry = require('./registry');
const status = require('./status');
const store = require('./users/store');
const { gatewayLog } = require('./log');

class Dashboard {
  constructor({
    url = config.dashboard.url,
    token = config.dashboard.token,
    intervalMs = config.dashboard.intervalMs,
    getSessions = () => [],
    requestPairing = null,
  } = {}) {
    this.url = url;
    this.token = token;
    this.intervalMs = intervalMs;
    this.getSessions = getSessions;
    this.requestPairing = requestPairing;
    this.timer = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.enabled = Boolean(url && token);
  }

  payload() {
    return {
      botName: config.botName,
      at: new Date().toISOString(),
      sessions: this.getSessions(),
      commands: status.snapshot(),
      registry: registry.list().map((entry) => entry.name),
      numbers: store.listNumbers(),
      owner: store.readOwner() || null,
    };
  }

  async syncOnce() {
    if (!this.enabled) return { skipped: true };
    try {
      const res = await axios.post(`${this.url}/api/bot/sync`, this.payload(), {
        timeout: 15_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
      });
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;

      // The only inbound action honoured: a pairing request.
      const pairing = res.data?.pair;
      if (pairing?.number && typeof this.requestPairing === 'function') {
        await this.requestPairing(pairing.number);
      }
      return { ok: true };
    } catch (err) {
      this.lastError = err.message;
      gatewayLog.warn('dashboard sync failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  start() {
    if (!this.enabled) {
      gatewayLog.info('dashboard sync off (DASHBOARD_URL + BOT_SYNC_TOKEN not set)');
      return false;
    }
    void this.syncOnce();
    this.timer = setInterval(() => { void this.syncOnce(); }, this.intervalMs);
    this.timer.unref?.();
    gatewayLog.info('dashboard sync on', { url: this.url, intervalMs: this.intervalMs });
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  health() {
    return {
      enabled: this.enabled,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }
}

module.exports = { Dashboard };
