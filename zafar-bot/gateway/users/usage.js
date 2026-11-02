'use strict';

/**
 * gateway/users/usage.js — per-user, per-command cooldowns and counters.
 *
 * In-memory on purpose: a cooldown that survives a restart is a surprise, and
 * these numbers are cheap to rebuild. Durable counters live in users.json via
 * store.recordCommandUse().
 */

const lastRun = new Map(); // `${number}:${user}:${command}` -> epoch ms

const key = (number, user, command) => `${number}:${user}:${String(command).toLowerCase()}`;

/**
 * @returns {{allowed:boolean, retryInSec:number}}
 */
function check(number, user, command, cooldownSec) {
  const seconds = Number(cooldownSec) || 0;
  if (seconds <= 0) return { allowed: true, retryInSec: 0 };
  const k = key(number, user, command);
  const last = lastRun.get(k) || 0;
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed >= seconds) return { allowed: true, retryInSec: 0 };
  return { allowed: false, retryInSec: Math.max(1, Math.ceil(seconds - elapsed)) };
}

function mark(number, user, command) {
  lastRun.set(key(number, user, command), Date.now());
}

function reset(number, user, command) {
  if (command === undefined) {
    const prefix = `${number}:${user}:`;
    for (const k of [...lastRun.keys()]) if (k.startsWith(prefix)) lastRun.delete(k);
    return;
  }
  lastRun.delete(key(number, user, command));
}

function _resetAll() {
  lastRun.clear();
}

module.exports = { check, mark, reset, _resetAll };
