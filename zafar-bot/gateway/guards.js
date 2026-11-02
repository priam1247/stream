'use strict';

/**
 * gateway/guards.js — the exact order from the spec.
 *
 *   1. fromMe check
 *   2. banned? stop silently
 *   3. access mode: whitelisted or open
 *   4. maintenance on? only admins pass
 *   5. command's required role (command.json)
 *   6. per-user command block
 *   7. cooldown for that user and that command
 *   8. dispatch
 *
 * Steps 2-6 live in users/access.js so they can be unit-tested without a socket.
 * This module wires them to the message and returns one decision object. It
 * never throws for a policy refusal: a refusal is an outcome, not an error.
 *
 * IMPORTANT — see MIGRATION_REPORT.md, decision A. The old bot served ONLY
 * messages where `key.fromMe === true` (the linked account talking to itself).
 * Step 1 preserves exactly that. The consequence is that steps 2 and 3 can only
 * fire for a sender other than the linked account, which the self-bot path never
 * produces. They are implemented, ordered and tested anyway, because the spec
 * requires them and because a future multi-user mode needs them.
 */

const jid = require('../lib/jid');
const store = require('./users/store');
const access = require('./users/access');
const usage = require('./users/usage');

const MODE = Object.freeze({
  IGNORE: 'ignore',        // no reply at all
  NOT_AUTHORIZED: 'not-authorized',
  REPLAY: 'replay',        // dispatch to the command
});

/**
 * @param {object} input
 * @param {object} input.message        { fromMe, chat, sender }
 * @param {string} input.number         the linked number that received the message
 * @param {object} input.command        registry entry (has meta.role, meta.cooldownSec, name)
 * @returns {{mode:string, reason:string, role:string, retryInSec:number}}
 */
function evaluate({ message, number, command }) {
  // 1. fromMe — the bot's own messages only.
  if (!message || message.fromMe !== true) {
    return { mode: MODE.IGNORE, reason: 'not-from-me', role: null, retryInSec: 0 };
  }

  const sender = jid.digits(message.sender);
  if (!jid.isNumber(sender)) {
    return { mode: MODE.IGNORE, reason: 'no-sender', role: null, retryInSec: 0 };
  }

  let settings;
  let user;
  try {
    settings = store.readSettings(number);
    user = store.getUser(number, sender);
  } catch (err) {
    // A corrupt users.json must not silently open the bot.
    return { mode: MODE.IGNORE, reason: `store-error: ${err.message}`, role: null, retryInSec: 0 };
  }

  const verdict = access.canRun({
    number,
    userNumber: sender,
    settings,
    requiredRole: command?.meta?.role || 'user',
    command: command?.name || '',
    user,
    ownerNumber: store.readOwner(),
  });

  if (verdict.allowed) {
    // 7. cooldown, last before dispatch.
    const cooldown = usage.check(number, sender, command.name, command?.meta?.cooldownSec);
    if (!cooldown.allowed) {
      return { mode: MODE.NOT_AUTHORIZED, reason: 'cooldown', role: verdict.role, retryInSec: cooldown.retryInSec };
    }
    return { mode: MODE.REPLAY, reason: 'ok', role: verdict.role, retryInSec: 0 };
  }

  if (verdict.reason === 'banned') {
    return { mode: MODE.IGNORE, reason: 'banned', role: verdict.role, retryInSec: 0 };
  }
  if (verdict.reason === 'not-whitelisted') {
    return { mode: MODE.NOT_AUTHORIZED, reason: 'not-whitelisted', role: verdict.role, retryInSec: 0 };
  }
  return { mode: MODE.NOT_AUTHORIZED, reason: verdict.reason, role: verdict.role, retryInSec: 0 };
}

/** The single polite refusal message. Wording fixed by the spec. */
function refusalText(reason, { retryInSec = 0 } = {}) {
  if (reason === 'cooldown') return `⏳ Slow down. Try again in ${retryInSec}s.`;
  if (reason === 'maintenance') return '🔧 The bot is in maintenance. Please try again later.';
  if (reason === 'role-too-low') return '❌ This command is restricted.';
  if (reason === 'blocked-command') return '❌ You are not allowed to use this command.';
  return '🔒 You are not authorized to use this bot.';
}

module.exports = { evaluate, refusalText, MODE };
