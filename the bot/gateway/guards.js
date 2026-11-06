'use strict';

/**
 * Message guards — decide whether THIS socket may act on THIS message.
 *
 * Rules (all must hold, checked in this order):
 *   1. The message was sent by the account that owns this socket (fromMe).
 *      Other people's messages never trigger a command, anywhere.
 *   2. In a group, the sender recorded on the message must be that same
 *      account. If several approved accounts share a group, each socket sees
 *      every message but only the sender's own socket passes this guard.
 *   3. The account is currently approved and connected (sock.__canRespond).
 *   4. The message is claimed by exactly one socket. Even if the same chat
 *      message reaches two sockets, only the first claimant may run it.
 *
 * Replies are always sent back through the claiming socket and quoted to the
 * original message, so a response can only ever reach the person who asked.
 */

const { jidVariants, splitIdentity } = require('../lib/jid');
const accountSockets = require('../lib/accountSockets');
const { readWL, findAllowedUserIndex } = require('./users/access');

const CLAIM_TTL_MS = 10 * 60 * 1000;
const MAX_CLAIMS = 5000;
const claims = new Map(); // `${chat}:${id}` -> { at, session }

const isGroupJid = (jid) => String(jid || '').endsWith('@g.us');

function ownIds(sock) {
  const number = sock?.__accountNumber;
  return [number ? `${number}@s.whatsapp.net` : null, sock?.user?.id, sock?.user?.lid].filter(Boolean);
}

function sweep(now) {
  if (claims.size < MAX_CLAIMS / 2 && claims.size % 50 !== 0) return;
  for (const [key, c] of claims) if (now - c.at > CLAIM_TTL_MS) claims.delete(key);
  while (claims.size > MAX_CLAIMS) claims.delete(claims.keys().next().value);
}

/** True when the sender recorded on the message is this socket's own account. */
function isOwnSender(sock, msg) {
  if (msg?.key?.fromMe !== true) return false;
  const chat = msg.key.remoteJid;
  if (!isGroupJid(chat)) return true;
  const participant = msg.key.participant || msg.participant;
  if (!participant) return true; // own group messages normally carry no participant
  const mine = jidVariants(ownIds(sock), sock.__sessionDir);
  const theirs = jidVariants(participant, sock.__sessionDir);
  if (!mine.size || !theirs.size) return true; // cannot compare; WhatsApp already marked it fromMe
  if ([...theirs].some((id) => mine.has(id))) return true;
  // An @lid participant we cannot map to a phone number is still our own
  // message (fromMe is set by WhatsApp). Only a participant we can positively
  // identify as a DIFFERENT number is rejected.
  return !splitIdentity(participant, sock.__sessionDir).pn;
}

/** First socket to claim a chat message wins; other sockets get false. */
function claim(sock, msg, now = Date.now()) {
  const chat = msg?.key?.remoteJid;
  const id = msg?.key?.id;
  if (!chat || !id) return true;
  sweep(now);
  const key = `${chat}:${id}`;
  const session = accountSockets.sessionKey(sock);
  const existing = claims.get(key);
  if (existing && existing.session !== session) return false;
  if (!existing) claims.set(key, { at: now, session });
  return true;
}

/** @returns {{ allow: boolean, reason: string }} */
function evaluate(sock, msg) {
  if (!msg?.message) return { allow: false, reason: 'empty' };
  if (msg.key?.fromMe !== true) return { allow: false, reason: 'not-sender' };
  if (!isOwnSender(sock, msg)) return { allow: false, reason: 'foreign-participant' };
  if (typeof sock.__canRespond === 'function' && !sock.__canRespond()) return { allow: false, reason: 'not-approved' };
  if (!claim(sock, msg)) return { allow: false, reason: 'claimed-by-other-session' };
  return { allow: true, reason: 'ok' };
}

/**
 * Allowed (whitelisted) users who message in a GROUP from their own number.
 * Never in a DM. Only the linked number that ran `.allow` for them replies;
 * entries with no recorded session fall back to the first socket to claim.
 * A user with their own linked number is answered by that socket instead.
 * @returns {{ allow: boolean, reason: string, sender?: string, senderIds?: string[] }}
 */
function evaluateAllowedUser(sock, msg) {
  if (!msg?.message) return { allow: false, reason: 'empty' };
  if (msg.key?.fromMe === true) return { allow: false, reason: 'own-message' };
  if (!isGroupJid(msg.key?.remoteJid)) return { allow: false, reason: 'not-group' };
  const participant = msg.key.participant || msg.participant;
  if (!participant) return { allow: false, reason: 'no-participant' };
  const senderIds = [participant, msg.key.participantAlt].filter(Boolean);
  let users;
  try { users = readWL().users; } catch { return { allow: false, reason: 'whitelist-unavailable' }; }
  const idx = findAllowedUserIndex(users, senderIds, sock.__sessionDir);
  if (idx === -1) return { allow: false, reason: 'not-allowed' };
  const via = users[idx].allowedVia;
  if (via && via !== accountSockets.sessionKey(sock)) return { allow: false, reason: 'allowed-by-other-session' };
  const theirs = jidVariants(senderIds, sock.__sessionDir);
  // The socket's own account is only ever served through the fromMe path.
  if ([...jidVariants(ownIds(sock), sock.__sessionDir)].some((id) => theirs.has(id))) return { allow: false, reason: 'own-account' };
  const hasOwnSession = accountSockets.list().some((s) => {
    if (typeof s.__canRespond === 'function' && !s.__canRespond()) return false;
    return [...jidVariants(ownIds(s), s.__sessionDir)].some((id) => theirs.has(id));
  });
  if (hasOwnSession) return { allow: false, reason: 'has-own-session' };
  if (typeof sock.__canRespond === 'function' && !sock.__canRespond()) return { allow: false, reason: 'not-approved' };
  if (!claim(sock, msg)) return { allow: false, reason: 'claimed-by-other-session' };
  return { allow: true, reason: 'ok', sender: participant, senderIds };
}

const _resetForTests = () => claims.clear();

module.exports = { evaluate, evaluateAllowedUser, isOwnSender, claim, ownIds, isGroupJid, _resetForTests };
