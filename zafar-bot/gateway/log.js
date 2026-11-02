'use strict';

/**
 * gateway/log.js — the log files.
 *
 *   logs/gateway.log   boot, sessions, routing decisions, runner kills
 *   logs/users.log     every write to a users.json (append-only audit)
 *   logs/<command>.log one per command, written by the child process
 *
 * Every write is synchronous and flushed. A crash must not lose the line that
 * explains the crash.
 */

const fs = require('fs');
const path = require('path');
const { paths, commandLog, assertName } = require('../lib/paths');

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

const FORBIDDEN = [
  'prekey', 'chainkey', 'registrationid', 'ratchet', 'ephemeralkeypair',
  'signal protocol', 'basekey', 'sessionentry',
];

function redact(text) {
  let s = String(text ?? '');
  s = s.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+|/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b\d+\|[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/\b((?:https?|socks5?):\/\/[^:/@\s]+):([^@\s]+)@/gi, '$1:***@');
  s = s.replace(/([?&](?:api_?key|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(SECRET|TOKEN|KEY|PASSWORD|PASSWD)/i.test(key)) continue;
    const secret = String(value || '').trim();
    if (secret.length >= 10) s = s.split(secret).join('[REDACTED]');
  }
  return s;
}

function isBaileysNoise(line) {
  const low = line.toLowerCase();
  return FORBIDDEN.some((pattern) => low.includes(pattern));
}

function append(file, line) {
  if (isBaileysNoise(line)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, redact(line) + '\n', { mode: 0o600 });
  } catch (err) {
    // The log is the last resort; if it cannot be written, say so on stderr.
    process.stderr.write(`[log-write-failed] ${file}: ${err.message}\n`);
  }
}

function stamp() {
  const d = new Date();
  return `${d.toISOString()} `;
}

function format(level, scope, message, extra) {
  const tail = extra === undefined ? '' : ' ' + safeJson(extra);
  return `${stamp()}${level.toUpperCase().padEnd(5)} [${scope}] ${message}${tail}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makeLogger(file, scope) {
  const emit = (level, message, extra) => {
    if (LEVELS[level] < threshold) return;
    const line = format(level, scope, message, extra);
    append(file, line);
    // Also write to the console. A panel only shows stdout/stderr; when boot
    // messages went to the file alone, a failed start looked like a silent
    // process that quit. Errors go to stderr so they are never hidden.
    if (CONSOLE_LOG) {
      if (LEVELS[level] >= LEVELS.error) console.error(line);
      else console.log(line);
    }
  };
  return {
    scope,
    file,
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

// Console mirroring is on by default; set LOG_CONSOLE=0 for file-only logging.
const CONSOLE_LOG = !/^(0|false|no|off)$/i.test(String(process.env.LOG_CONSOLE ?? 'true'));

const gatewayLog = makeLogger(paths.gatewayLog, 'gateway');
const usersLog = makeLogger(paths.usersLog, 'users');

/** Logger for one command, used inside its child process. */
function commandLogger(name) {
  assertName(name);
  return makeLogger(commandLog(name), name);
}

module.exports = { gatewayLog, usersLog, commandLogger, makeLogger, redact, LEVELS };
