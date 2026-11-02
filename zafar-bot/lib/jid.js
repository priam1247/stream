'use strict';

/**
 * lib/jid.js — number normalisation only.
 *
 * Gateway and commands both use this. It knows nothing about Baileys beyond
 * the "@s.whatsapp.net" suffix shape, so a Baileys change cannot reach into
 * command code through here.
 */

const PN_SUFFIX = '@s.whatsapp.net';
const GROUP_SUFFIX = '@g.us';
const STATUS_JID = 'status@broadcast';

/** Digits only. Returns '' when the input holds no usable number. */
function digits(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/@.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\D/g, '');
}

/** True when the digits look like an international number we accept. */
function isNumber(value) {
  const d = digits(value);
  return d.length >= 7 && d.length <= 15;
}

/** '265991234567' -> '265991234567@s.whatsapp.net' */
function toJid(value) {
  const d = digits(value);
  if (!isNumber(d)) throw new Error(`not a usable WhatsApp number: ${JSON.stringify(value)}`);
  return d + PN_SUFFIX;
}

/** '265991234567@s.whatsapp.net' -> '265991234567' */
function fromJid(jid) {
  return digits(jid);
}

function isGroup(jid) {
  return String(jid || '').endsWith(GROUP_SUFFIX);
}

function isStatus(jid) {
  return String(jid || '') === STATUS_JID;
}

/** Stable key for a chat, used for selection scope and logging. */
function chatKey(jid) {
  return isGroup(jid) ? String(jid) : toJid(jid);
}

/**
 * Every textual form a sender might arrive as, for comparing against a stored
 * number. Baileys may hand us a PN JID, a LID JID, or a device-suffixed JID.
 */
function variants(jid) {
  const raw = String(jid || '').trim();
  const out = new Set();
  if (!raw) return out;
  out.add(raw);
  const bare = raw.replace(/@.*$/, '').replace(/:\d+$/, '');
  if (bare) {
    out.add(bare);
    out.add(bare + PN_SUFFIX);
  }
  const d = digits(raw);
  if (d) {
    out.add(d);
    out.add(d + PN_SUFFIX);
  }
  return out;
}

module.exports = {
  PN_SUFFIX,
  GROUP_SUFFIX,
  digits,
  isNumber,
  toJid,
  fromJid,
  isGroup,
  isStatus,
  chatKey,
  variants,
};
