/**
 * ZaFar Bot — console logger
 *
 * One format for the whole process so the panel log is readable:
 *
 *   22:49:41.798  INFO   command   .movie ← 265894016453
 *   22:49:42.844  WARN   engine    registry: vaplayer tripped (fetch failed)
 *
 * Levels: debug < info < warn < error. `LOG_LEVEL=debug` turns on the noisy
 * detail (per-provider attempts, paper window walks, download progress).
 * Nothing here prints secrets; timestamps are local time.
 */

'use strict';

const { redactSecrets, redactArg, safeText } = require('./safeLog');

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
let threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR
  ? { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' }
  : { debug: '', info: '', warn: '', error: '', dim: '', reset: '' };

const stamp = () => {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const render = (v) => safeText(v);

/** Trim to one line and redact credentials so panel logs never leak secrets. */
const oneLine = (s) => redactSecrets(String(s)).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 500);

function emit(level, tag, parts) {
  if (LEVELS[level] < threshold) return;
  const line =
    `${COLORS.dim}${stamp()}${COLORS.reset}  ` +
    `${COLORS[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset}  ` +
    `${String(tag).padEnd(9)} ` +
    oneLine(parts.map(render).join(' '));
  (LEVELS[level] >= 40 ? console.error : console.log)(line);
}

/** Logger bound to a subsystem, e.g. const log = require('./logger')('movie'). */
function createLogger(tag) {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
    raw: (...a) => console.log(...a.map(redactArg)),
  };
}

/** Startup banner: one compact block instead of a dozen loose lines. */
function banner(lines = []) {
  const width = Math.max(44, ...lines.map(l => l.length + 4));
  const bar = '─'.repeat(width);
  console.log(`\n┌${bar}┐`);
  for (const raw of lines) {
    const text = redactSecrets(String(raw));
    console.log(`│  ${text}${' '.repeat(Math.max(0, width - text.length - 2))}│`);
  }
  console.log(`└${bar}┘\n`);
}

/** Section header for multi-step work (commands, tests). */
const section = (tag, text) => emit('info', tag, [`── ${text} ──`]);

module.exports = createLogger;
module.exports.createLogger = createLogger;
module.exports.banner = banner;
module.exports.section = section;
module.exports.LEVELS = LEVELS;
module.exports.setLevel = (name) => {
  const normalized = String(name).toLowerCase();
  if (LEVELS[normalized]) {
    threshold = LEVELS[normalized];
    process.env.LOG_LEVEL = normalized;
  }
};
