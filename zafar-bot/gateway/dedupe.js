'use strict';

/**
 * gateway/dedupe.js — two jobs, both about "exactly one message out".
 *
 * 1. OWN-ECHO SUPPRESSION
 *    WhatsApp delivers a message we send to every linked socket that shares the
 *    chat. Session B sees session A's reply arrive as a normal inbound message.
 *    Without suppression, B would try to run whatever text A happened to send.
 *    Every outbound key.id is remembered for a short window and dropped on the way
 *    back in. This is what makes the bot safe in a group with several linked
 *    numbers.
 *
 * 2. SINGLE RESPONDER
 *    If two of our numbers are both in the same group, both receive the same
 *    message and both would answer: the group gets two copies. Exactly one socket
 *    may reply, and the rule for which one is:
 *
 *      a) if the sender is one of OUR linked numbers, only that socket replies
 *         (the owner asked from their own phone; the reply must come from it);
 *      b) otherwise the first socket to see the message claims it and the rest
 *         stand down.
 *
 *    Both are in-process and synchronous, so there is no race to lose.
 */

const ECHO_TTL_MS = 2 * 60 * 1000;
const CLAIM_TTL_MS = 2 * 60 * 1000;

/** message ids we sent ourselves -> timestamp */
const sentIds = new Map();
/** message ids already answered -> timestamp */
const claimed = new Map();

function sweep(map, ttl, now) {
  for (const [key, at] of map) {
    if (now - at > ttl) map.delete(key);
  }
}

/** Remember an outbound message so its echo is ignored when it comes back. */
function rememberSend(id) {
  if (!id) return;
  sentIds.set(String(id), Date.now());
}

/** True when this inbound message is actually a message we just sent. */
function isOwnSend(id) {
  if (!id) return false;
  const at = sentIds.get(String(id));
  if (!at) return false;
  if (Date.now() - at > ECHO_TTL_MS) {
    sentIds.delete(String(id));
    return false;
  }
  return true;
}

/**
 * Decide whether THIS socket should answer.
 *
 * @param {object} args
 * @param {string} args.id      the message id (same on every socket that got it)
 * @param {string} args.sender  digits of whoever sent it
 * @param {string} args.number  the linked number behind this socket
 * @param {string[]} args.linked  every currently connected linked number
 * @returns {{respond:boolean, reason:string}}
 */
function claimResponder({ id, sender, number, linked = [] }) {
  const now = Date.now();
  sweep(claimed, CLAIM_TTL_MS, now);
  sweep(sentIds, ECHO_TTL_MS, now);

  const key = String(id || '');
  if (!key) return { respond: false, reason: 'no-message-id' };

  const senderIsOurs = linked.includes(String(sender || ''));

  // (a) the owner/student sent this from one of our own numbers: that socket and
  //     only that socket answers. Deterministic, no race.
  if (senderIsOurs) {
    return String(sender) === String(number)
      ? { respond: true, reason: 'from-my-own-number' }
      : { respond: false, reason: 'sender-handled-it' };
  }

  // (b) a normal person (an approved student): whichever socket arrives first
  //     answers, the rest stand down.
  if (claimed.has(key)) {
    return { respond: false, reason: 'already-claimed' };
  }
  claimed.set(key, now);
  return { respond: true, reason: 'claimed' };
}

/** Test seam: forget everything. */
function _reset() {
  sentIds.clear();
  claimed.clear();
}

module.exports = { rememberSend, isOwnSend, claimResponder, _reset, ECHO_TTL_MS, CLAIM_TTL_MS };
