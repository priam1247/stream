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
 * WHO GETS SERVED
 *
 * The bot answers approved people only — never the general public. Two kinds of
 * sender are allowed:
 *
 *   - one of our OWN linked numbers (the owner asking from their own phone), and
 *   - a person explicitly approved on that number via `.users add`.
 *
 * Everyone else is ignored with no reply at all. An unknown sender never learns
 * the bot is listening.
 *
 * Step 1 used to be `fromMe === true`, which made the bot a private self-bot.
 * It now accepts a message that is either fromMe OR from a bare-number contact
 * (a DM). Group messages carry a `participant` jid and are handled separately,
 * because a group must be switched on for the bot to answer in it at all.
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
function evaluate({ message, number, command, linked = [] }) {
  // 1. where did this come from?
  //    - our own account (fromMe): always in scope
  //    - a direct chat with a person: in scope, subject to approval below
  //    - a group: only if that group has been switched on for this number
  //    - anything else (status, broadcast): out of scope, silently
  if (!message) {
    return { mode: MODE.IGNORE, reason: 'no-message', role: null, retryInSec: 0 };
  }
  if (message.isGroup) {
    if (!message.groupEnabled) {
      return { mode: MODE.IGNORE, reason: 'group-not-enabled', role: null, retryInSec: 0 };
    }
    // A group message from one of our own phones is answered only by the socket
    // that owns that phone; the decision is made in gateway/dedupe.js, which has
    // already run by the time we get here.
  } else if (!message.fromMe && message.chatKind !== 'dm') {
    return { mode: MODE.IGNORE, reason: 'not-a-dm', role: null, retryInSec: 0 };
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
    linked,
  });

  if (verdict.allowed) {
    // 7. cooldown, last before dispatch.
    const cooldown = usage.check(number, sender, command.name, command?.meta?.cooldownSec);
    if (!cooldown.allowed) {
      return { mode: MODE.NOT_AUTHORIZED, reason: 'cooldown', role: verdict.role, retryInSec: cooldown.retryInSec };
    }
    return { mode: MODE.REPLAY, reason: 'ok', role: verdict.role, retryInSec: 0 };
  }

  // Silence for anything that would tell a stranger the bot exists: not approved,
  // banned, or a store failure. Only an APPROVED person gets a described refusal.
  if (['banned', 'not-approved', 'no-settings'].includes(verdict.reason)) {
    return { mode: MODE.IGNORE, reason: verdict.reason, role: verdict.role, retryInSec: 0 };
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
