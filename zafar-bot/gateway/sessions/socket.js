'use strict';

/**
 * gateway/sessions/socket.js — Baileys connect + reconnect, per session.
 *
 * One instance per linked number. A failure here is contained: the class owns a
 * single socket, one reconnect schedule, and never touches another session.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
} = require('@whiskeysockets/baileys');

const { sessionDir } = require('../../lib/paths');
const { gatewayLog } = require('../log');

const VERSION_TTL_MS = 60 * 60 * 1000;
let cachedVersion = null;
let cachedAt = 0;
let inFlight = null;

/**
 * WhatsApp Web version. When the lookup fails we do NOT invent a version: the
 * old bot fell back to a hardcoded [2,3000,...] triple, which made a failed
 * lookup look like a successful one. Here it throws, and the session reports ❌.
 */
async function webVersion() {
  if (cachedVersion && Date.now() - cachedAt < VERSION_TTL_MS) return cachedVersion;
  if (!inFlight) {
    inFlight = Promise.resolve(fetchLatestWaWebVersion())
      .then((result) => {
        if (!result?.version) throw new Error('fetchLatestWaWebVersion returned no version');
        cachedVersion = result.version;
        cachedAt = Date.now();
        return cachedVersion;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

function quietLogger() {
  return pino({ level: 'silent' });
}

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

class Session {
  /**
   * @param {object} opts
   * @param {string} opts.number
   * @param {(number:string, sock:object, message:object)=>Promise<any>} opts.onMessage
   * @param {(number:string, err:Error)=>void} [opts.onFatal]
   */
  constructor({ number, onMessage, onFatal }) {
    this.number = number;
    this.dir = sessionDir(number);
    this.onMessage = onMessage;
    this.onFatal = onFatal;

    this.sock = null;
    this.state = 'idle';      // idle | connecting | open | closed | logged_out
    this.attempts = 0;
    this.lastError = null;
    this.timer = null;
    this.stopped = false;
    this.pairingCode = null;
  }

  status() {
    return {
      number: this.number,
      state: this.state,
      attempts: this.attempts,
      lastError: this.lastError ? String(this.lastError).slice(0, 300) : null,
      pairingCode: this.pairingCode,
    };
  }

  async start() {
    if (this.stopped) return;
    this.state = 'connecting';
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await useMultiFileAuthState(this.dir);
      const version = await webVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        logger: quietLogger(),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        downloadHistory: false,
        markOnlineOnConnect: false,
      });

      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => this.onConnectionUpdate(update));
      sock.ev.on('messages.upsert', async (event) => {
        for (const message of event?.messages || []) {
          try {
            await this.onMessage(this.number, sock, message);
          } catch (err) {
            // A single bad message must never kill the session.
            gatewayLog.error('message handler failed', { number: this.number, error: err.message });
          }
        }
      });

      return sock;
    } catch (err) {
      this.state = 'closed';
      this.lastError = err.message;
      gatewayLog.error('session start failed', { number: this.number, error: err.message });
      this.scheduleReconnect();
      return null;
    }
  }

  onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      this.lastError = 'QR code issued; scan it to link this number';
      gatewayLog.warn('session issued a QR code', { number: this.number });
      // Print it. Receiving the QR without showing it made manual linking
      // impossible: the only way in was a pairing code, and that was broken too.
      try {
        // eslint-disable-next-line global-require
        const qrcode = require('qrcode-terminal');
        console.log(`\n  Scan this QR code for ${this.number} with WhatsApp → Linked devices:\n`);
        qrcode.generate(qr, { small: true });
        console.log('');
      } catch (err) {
        gatewayLog.warn('could not render the QR code', { number: this.number, error: err.message });
      }
    }

    if (connection === 'open') {
      this.state = 'open';
      this.attempts = 0;
      this.lastError = null;
      gatewayLog.info('session open', { number: this.number });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      this.state = 'closed';
      this.lastError = lastDisconnect?.error?.message || `closed (${code ?? 'unknown'})`;

      if (code === DisconnectReason.loggedOut) {
        this.state = 'logged_out';
        gatewayLog.error('session logged out; credentials must be re-linked', { number: this.number });
        this.onFatal?.(this.number, new Error('logged out'));
        return;
      }
      gatewayLog.warn('session closed', { number: this.number, code, error: this.lastError });
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    this.attempts += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.start(); }, delay);
    this.timer.unref?.();
  }

  async requestPairingCode(phone) {
    if (!this.sock) throw new Error('session has no socket yet');
    const code = await this.sock.requestPairingCode(phone);
    this.pairingCode = code;
    return code;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try { await this.sock?.end?.(undefined); } catch (err) {
      gatewayLog.warn('session end failed', { number: this.number, error: err.message });
    }
    this.state = 'closed';
    this.sock = null;
  }

  /** Test hook: pretend the socket dropped without touching a real session. */
  _simulateClose(code = 428) {
    this.onConnectionUpdate({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: code }, message: `simulated ${code}` } },
    });
  }
}

module.exports = { Session, webVersion, _resetVersionCache: () => { cachedVersion = null; cachedAt = 0; } };
void path;
