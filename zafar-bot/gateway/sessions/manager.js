'use strict';

/**
 * gateway/sessions/manager.js — start/stop/list sessions.
 *
 * Each linked number is an independent Session. A bad session (crash, logout,
 * endless reconnect) never affects the others: there is no shared socket state
 * and no shared reconnect schedule.
 */

const fs = require('fs');
const { paths, sessionDir } = require('../../lib/paths');
const { Session } = require('./socket');
const store = require('../users/store');
const { gatewayLog } = require('../log');
const jid = require('../../lib/jid');
const config = require('../config');

class SessionManager {
  /** @param {{onMessage:Function, maxAccounts?:number}} opts */
  constructor({ onMessage, maxAccounts = config.maxLinkedAccounts }) {
    this.onMessage = onMessage;
    this.maxAccounts = maxAccounts;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /** Numbers with creds.json on disk. */
  static linkedNumbers() {
    if (!fs.existsSync(paths.sessionsLinked)) return [];
    return fs.readdirSync(paths.sessionsLinked)
      .filter((name) => /^\d{7,15}$/.test(name))
      .filter((name) => fs.existsSync(`${sessionDir(name)}/creds.json`))
      .sort();
  }

  /**
   * Start every number that already has credentials, and — if none do and
   * PAIR_NUMBER is set — begin linking that number.
   *
   * Without this the bot boots with no socket at all and sits there forever. The
   * old bot did the pairing in index.js; the rebuild read PAIR_NUMBER into config
   * and never used it, so a fresh install could never link.
   */
  async startAll() {
    const numbers = SessionManager.linkedNumbers();
    for (const number of numbers) {
      await this.start(number);
    }

    if (!numbers.length) {
      const pair = jid.digits(config.pairNumber);
      if (jid.isNumber(pair)) {
        gatewayLog.info('no linked numbers; starting pairing for PAIR_NUMBER', { number: pair });
        // A pairing attempt must not abort boot: if it fails the service still has
        // to stay up for a retry or a dashboard request.
        try {
          const session = await this.start(pair);
          const code = await session.requestPairingCode(pair);
          gatewayLog.warn('PAIRING CODE — enter it in WhatsApp under Linked devices', { number: pair, code });
          console.log(`\n  Pairing code for ${pair}: ${code}\n  WhatsApp → Linked devices → Link a device → "Link with phone number instead"\n`);
        } catch (err) {
          gatewayLog.error('pairing failed at boot', { number: pair, error: err.message });
        }
      } else {
        gatewayLog.warn('no linked numbers and PAIR_NUMBER is not set — nothing to connect. Set PAIR_NUMBER in .env, or pair from the dashboard.', { dir: paths.sessionsLinked });
      }
    }
    return this.list();
  }

  async start(number) {
    if (this.sessions.has(number)) return this.sessions.get(number);
    if (this.sessions.size >= this.maxAccounts) {
      throw new Error(`refusing to start ${number}: MAX_LINKED_ACCOUNTS (${this.maxAccounts}) reached`);
    }
    store.ensureNumber(number);
    const session = new Session({
      number,
      onMessage: (n, sock, message) => this.onMessage(n, sock, message),
      onFatal: (n, err) => gatewayLog.error('session fatal', { number: n, error: err.message }),
    });
    this.sessions.set(number, session);
    await session.start();
    return session;
  }

  async stop(number) {
    const session = this.sessions.get(number);
    if (!session) return false;
    await session.stop();
    this.sessions.delete(number);
    return true;
  }

  async stopAll() {
    for (const number of [...this.sessions.keys()]) await this.stop(number);
  }

  get(number) {
    return this.sessions.get(number) || null;
  }

  /** Live socket for a number, or null. */
  sock(number) {
    const session = this.sessions.get(number);
    return session && session.state === 'open' ? session.sock : null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.status());
  }

  /** Numbers that have a working socket right now. */
  openNumbers() {
    return [...this.sessions.values()].filter((s) => s.state === 'open').map((s) => s.number);
  }
}

module.exports = { SessionManager };
