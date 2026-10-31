'use strict';

/**
 * ZaFar Bot — YouTube OAuth2 Device-Code Credentials (`.ytlogin`)
 *
 * Adapted from levanter's TV OAuth2 flow (`youtubei.js` session.signIn()):
 *   • Owner runs `.ytlogin` → gets `https://www.google.com/device` + an 8-char code.
 *   • Once approved on phone/PC, OAuth2 tokens (`access_token`, `refresh_token`,
 *     `expiry_date`) are saved atomically to `database/yt_auth.json`.
 *   • Unlike browser `cookies.txt` (which expire or rotate whenever a browser
 *     session changes), OAuth2 refresh tokens renew automatically on use via
 *     `update-credentials`. Keep `database/*.json` private and preserve it
 *     when updating the service; repository CI does not overwrite it.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore');

const DB_DIR = path.join(__dirname, '..', 'database');
const AUTH_FILE = path.join(DB_DIR, 'yt_auth.json');

const _listeners = new Map();
let _generation = 0;
let _cancelLogin = null;

function onAuthChange(fn, key = Symbol('auth-listener')) {
  if (typeof fn !== 'function') return () => {};
  // A named listener can replace its previous hot-reloaded instance.
  _listeners.set(key, fn);
  return () => { if (_listeners.get(key) === fn) _listeners.delete(key); };
}

function notifyAuthChange() {
  _generation += 1;
  for (const fn of _listeners.values()) {
    try { fn(); } catch { /* ignore */ }
  }
}

const isValidCreds = (v) =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v) && (v.refresh_token || v.access_token));

function authFilePath() {
  return process.env.YT_AUTH_FILE ? path.resolve(process.env.YT_AUTH_FILE) : AUTH_FILE;
}

function getYtCreds() {
  const target = authFilePath();
  if (!fs.existsSync(target)) return null;
  const res = readJsonSafe(target, { defaultValue: null });
  if (!res.ok || !isValidCreds(res.data)) return null;
  return res.data;
}

function hasYtCreds() {
  return Boolean(getYtCreds());
}

function saveYtCreds(creds, { notify = true } = {}) {
  if (!isValidCreds(creds)) {
    throw Object.assign(new Error('Invalid YouTube OAuth credentials'), { code: 'BAD_YT_CREDS' });
  }
  const target = authFilePath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    ...creds,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(target, payload);
  try { fs.chmodSync(target, 0o600); } catch { /* windows */ }
  if (notify) notifyAuthChange();
  return payload;
}

function clearYtCreds() {
  // This state survives command hot reloads, so logout always cancels the
  // original pending login before it can write a late authorization.
  _cancelLogin?.();
  const target = authFilePath();
  let removed = false; let failure = null;
  // The atomic writer keeps a last-good copy containing the same OAuth secret.
  // An explicit logout must remove those local copies or report a clear failure.
  for (const file of [target, `${target}.bak`, `${target}.corrupt`]) {
    try { fs.unlinkSync(file); removed = true; }
    catch (err) { if (err?.code !== 'ENOENT') failure = err; }
  }
  notifyAuthChange();
  if (failure) throw Object.assign(new Error('Could not clear saved YouTube OAuth credentials.'), { code: 'YT_AUTH_CLEAR_FAILED', cause: failure });
  return removed;
}

let _ytModule = null;
async function loadYoutubei() {
  if (_ytModule) return _ytModule;
  _ytModule = await import('youtubei.js');
  return _ytModule;
}

/** Override for deterministic offline unit tests. */
let _innertubeFactory = null;
function _setInnertubeFactoryForTest(fn) {
  _innertubeFactory = fn;
}

/**
 * Start a Google TV OAuth2 device-code login session. The initial deadline also
 * covers client creation and code acquisition; cancellation ignores late events.
 *
 * @param {{ onCode?: (data: { verificationUrl: string, userCode: string, expiresIn: number }) => any, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<object>} saved OAuth credentials
 */
function startYtLogin({ onCode, timeoutMs, signal } = {}) {
  if (_cancelLogin) return Promise.reject(Object.assign(new Error('YouTube login is already pending.'), { code: 'LOGIN_PENDING' }));
  return new Promise((resolve, reject) => {
    let settled = false; let timer = null; let session = null;
    const requestedTimeout = Number(timeoutMs);
    const hasDeadline = Number.isFinite(requestedTimeout) && requestedTimeout > 0;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      session?.off?.('auth-pending', onPending);
      session?.off?.('auth', onAuth);
      session?.off?.('auth-error', onError);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (_cancelLogin === onAbort) _cancelLogin = null;
      cleanup();
      fn(value);
    };
    const armTimeout = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(reject, Object.assign(new Error('YouTube login timed out. Run .ytlogin again.'), { code: 'LOGIN_TIMEOUT' })), ms);
      timer.unref?.();
    };
    const onAbort = () => finish(reject, Object.assign(new Error('YouTube login cancelled.'), { code: 'LOGIN_CANCELLED' }));
    const onPending = (data) => {
      if (settled) return;
      const expiresSec = Math.max(30, Number(data?.expires_in) || 300);
      if (!hasDeadline) armTimeout((expiresSec + 10) * 1000);
      const verificationUrl = String(data?.verification_url || 'https://www.google.com/device').trim();
      const userCode = String(data?.user_code || '').trim();
      if (typeof onCode === 'function') {
        void Promise.resolve().then(() => { if (!settled) return onCode({ verificationUrl, userCode, expiresIn: expiresSec }); }).catch(() => {});
      }
    };
    const onAuth = (data) => {
      if (settled) return;
      try { finish(resolve, saveYtCreds(data?.credentials)); }
      catch (err) { finish(reject, err); }
    };
    const onError = (err) => finish(reject, err instanceof Error ? err : new Error(err?.message || 'YouTube OAuth failed'));

    _cancelLogin = onAbort;
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    armTimeout(hasDeadline ? requestedTimeout : 30_000);
    void Promise.resolve().then(async () => {
      const innertube = _innertubeFactory ? await _innertubeFactory() : await (async () => {
        const yt = await loadYoutubei();
        return yt.Innertube.create({ cache: new yt.UniversalCache(false), generate_session_locally: true });
      })();
      if (settled) return;
      session = innertube?.session;
      if (!session || typeof session.once !== 'function' || typeof session.signIn !== 'function') throw new Error('YouTube login is unavailable.');
      session.once('auth-pending', onPending);
      session.once('auth', onAuth);
      session.once('auth-error', onError);
      await session.signIn();
    }).catch((err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
  });
}

module.exports = {
  authFilePath,
  getYtCreds,
  hasYtCreds,
  saveYtCreds,
  clearYtCreds,
  onAuthChange,
  authGeneration: () => _generation,
  isLoginPending: () => Boolean(_cancelLogin),
  startYtLogin,
  _setInnertubeFactoryForTest,
};
