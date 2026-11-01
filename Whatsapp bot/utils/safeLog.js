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
  // A configured Deezer ARL may appear without a key in an unexpected error.
  for (const value of [process.env.DEEZER_ARL, process.env.DEEZER_COOKIE_ARL]) {
    const secret = String(value || '').trim();
    if (secret.length >= 10) s = s.split(secret).join('[REDACTED]');
  }
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
  s = s.replace(/(\b(?:deezer[_-]?(?:cookie[_-]?)?arl|arl|sid|session[_-]?id|checkform)\b["']?\s*[:=]\s*)(["']?)([^\s,;&"'{}]+)\2/gi, '$1$2[REDACTED]$2');
  s = s.replace(/(["']?(?:api[_-]?key|x[_-]?(?:bot|admin)[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|token|cookie|set-cookie)["']?\s*[:=]\s*)(["']?)([^\s,;&"'{}]+)\2/gi, '$1$2[REDACTED]$2');
  return s;
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|apikey|password|passwd|secret|privatekey|backupkey|encryptionkey|signingkey|cookies?|token|arl|sid|sessionid|checkform)$/.test(normalized);
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
  if (value instanceof Error) return summarizeError(redactArg(value));
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

// Error objects may carry entire HTTP requests. Only copy diagnostics we can
// safely redact; in particular, never retain config, headers, or response data.
const MAX_ERROR_DEPTH = 8;
const MAX_AGGREGATE_ERRORS = 20;
const MAX_ERROR_NODES = 100;
function redactArg(arg) {
  const seen = new WeakSet();
  let remaining = MAX_ERROR_NODES;
  const cleanValue = (value, depth) => {
    if (typeof value === 'string') return redactSecrets(value);
    if (value instanceof Error) {
      if (depth >= MAX_ERROR_DEPTH) return '[Error cause depth truncated]';
      if (seen.has(value)) return '[Circular error]';
      if (remaining-- <= 0) return '[Error chain truncated]';
      seen.add(value);
      try {
        const aggregate = value instanceof AggregateError;
        const clean = aggregate ? new AggregateError([], redactSecrets(value.message || '')) : new Error(redactSecrets(value.message || ''));
        clean.name = redactSecrets(value.name || 'Error');
        if (value.stack) clean.stack = redactSecrets(String(value.stack));
        if (typeof value.code === 'string') clean.code = redactSecrets(value.code);
        else if (typeof value.code === 'number' && Number.isFinite(value.code)) clean.code = value.code;
        for (const name of ['status', 'statusCode']) {
          if (typeof value[name] === 'number' && Number.isFinite(value[name])) clean[name] = value[name];
        }
        if ('cause' in value) clean.cause = cleanValue(value.cause, depth + 1);
        if (aggregate && Array.isArray(value.errors)) {
          clean.errors = value.errors.slice(0, MAX_AGGREGATE_ERRORS).map((error) => cleanValue(error, depth + 1));
          if (value.errors.length > MAX_AGGREGATE_ERRORS) clean.errors.push('[Additional errors omitted]');
        }
        return clean;
      } catch {
        return '[Unprintable error]';
      } finally { seen.delete(value); }
    }
    if (value && typeof value === 'object') {
      if (!depth) return safeText(value);
      if (depth >= MAX_ERROR_DEPTH) return '[Error cause depth truncated]';
      if (seen.has(value)) return '[Circular error]';
      if (remaining-- <= 0) return '[Error chain truncated]';
      // Some libraries reject with a plain object instead of Error. Retain only
      // its safe diagnostic fields, never request or response metadata.
      seen.add(value);
      try {
        const clean = {};
        if (typeof value.message === 'string') clean.message = redactSecrets(value.message);
        if (typeof value.code === 'string') clean.code = redactSecrets(value.code);
        else if (typeof value.code === 'number' && Number.isFinite(value.code)) clean.code = value.code;
        for (const name of ['status', 'statusCode']) {
          if (typeof value[name] === 'number' && Number.isFinite(value[name])) clean[name] = value[name];
        }
        if ('cause' in value) clean.cause = cleanValue(value.cause, depth + 1);
        return Object.keys(clean).length ? clean : '[Non-error cause omitted]';
      } catch { return '[Unprintable cause]'; }
      finally { seen.delete(value); }
    }
    return value;
  };
  return cleanValue(arg, 0);
}

// The subsystem logger renders to one line rather than using console's Error
// inspector. Include the same sanitized chain there without copying stacks.
function summarizeError(value) {
  if (!(value instanceof Error)) return safeText(value);
  const details = [];
  if (value.code !== undefined) details.push(`code=${value.code}`);
  if (value.status !== undefined) details.push(`status=${value.status}`);
  if (value.statusCode !== undefined) details.push(`statusCode=${value.statusCode}`);
  const parts = [`${value.name}: ${value.message}${details.length ? ` (${details.join(', ')})` : ''}`];
  if (Array.isArray(value.errors) && value.errors.length) parts.push(`errors: [${value.errors.map(summarizeError).join('; ')}]`);
  if ('cause' in value && value.cause != null) parts.push(`caused by: ${summarizeError(value.cause)}`);
  return parts.join('; ');
}

/** All arguments flattened into one lowercase string (used for noise filtering). */
const formatArgs = (args) => (Array.isArray(args) ? args : [args]).map(safeText).join(' ').toLowerCase();

module.exports = { safeText, formatArgs, redactSecrets, redactArg, maskUrlCredentials };
