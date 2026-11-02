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

  async startAll() {
    const numbers = SessionManager.linkedNumbers();
    for (const number of numbers) {
      await this.start(number);
    }
    if (!numbers.length) {
      gatewayLog.warn('no linked numbers found', { dir: paths.sessionsLinked });
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
