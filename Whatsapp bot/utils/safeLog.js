/**
 * ZaFar Bot — safe console formatting & secret redaction
 *
 * 1. The console wrappers in index.js stringify every argument to decide whether a
 *    line is noise. JSON.stringify() throws on circular references and on BigInt,
 *    and Baileys logs proto/socket objects that are full of both.
 * 2. redactSecrets() strips Bearer tokens, Pterodactyl panel keys (ptlc_/ptla_),
 *    Drime Sanctum tokens, URL query API keys, and proxy URL passwords so no
 *    log line ever prints credentials.
 */

function redactSecrets(input) {
  let s = String(input ?? '');
  if (!s) return s;
  // Authorization credentials can be bearer tokens or Basic auth.
  s = s.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+|/=-]{8,}/gi, '$1[REDACTED]');
  // Pterodactyl & Hydrodactyl client / application keys (ptlc_, ptla_, hydro_)
  s = s.replace(/\b(ptl[ca]_|hydro_)[A-Za-z0-9]{6,}/g, '$1[REDACTED]');
  // Sanctum / Drime tokens like 58989|qn4Jom8Cnusc...
  s = s.replace(/\b\d+\|[A-Za-z0-9]{24,}\b/g, '[REDACTED_TOKEN]');
  // URL user:password@host credentials (proxies, SFTP, etc.)
  s = s.replace(/\b((?:https?|socks5h?|sftp):\/\/[^:/@\s]+):([^@\s]+)@/gi, '$1:***@');
  // A cookie header can contain multiple semicolon-separated secrets.
  s = s.replace(/(\b(?:set-)?cookie\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]');
  // Query strings, structured error messages, and logfmt-style assignments.
  s = s.replace(/((?:[?&]|\b)(?:api_?key|access_token|token)=)[^&\s"']+/gi, '$1[REDACTED]');
  s = s.replace(/(["']?(?:api[_-]?key|x[_-]?(?:bot|admin)[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|token|cookie|set-cookie)["']?\s*[:=]\s*)(["']?)([^\s,;&"'{}]+)\2/gi, '$1$2[REDACTED]$2');
  return s;
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|apikey|password|passwd|secret|privatekey|backupkey|encryptionkey|signingkey|cookies?|token)$/.test(normalized);
}

function maskUrlCredentials(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return redactSecrets(raw);
}

function safeText(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return redactSecrets(`${value.name}: ${value.message}`);
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (key && isSensitiveKey(key)) return '[REDACTED]';
      if (typeof val === 'string') return redactSecrets(val);
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    return redactSecrets(json || String(value));
  } catch {
    try { return Object.prototype.toString.call(value); } catch { return '[unprintable]'; }
  }
}

function redactArg(arg) {
  if (typeof arg === 'string') return redactSecrets(arg);
  if (arg instanceof Error) {
    // HTTP errors often carry request headers and credentials as own properties.
    // Keep a sanitized stack and code, never the original error's metadata.
    const clean = new Error(redactSecrets(arg.message || ''));
    clean.name = redactSecrets(arg.name || 'Error');
    if (arg.stack) clean.stack = redactSecrets(String(arg.stack));
    if (typeof arg.code === 'string' || typeof arg.code === 'number') clean.code = redactSecrets(String(arg.code));
    return clean;
  }
  if (arg && typeof arg === 'object') return safeText(arg);
  return arg;
}

/** All arguments flattened into one lowercase string (used for noise filtering). */
const formatArgs = (args) => (Array.isArray(args) ? args : [args]).map(safeText).join(' ').toLowerCase();

module.exports = { safeText, formatArgs, redactSecrets, redactArg, maskUrlCredentials };
