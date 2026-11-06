'use strict';

/**
 * ctx — the helper bag every command receives as its fourth argument, plus the
 * owner check. Commands talk to WhatsApp only through `sock` + this bag.
 */

const config = require('../config');
const selections = require('../lib/selections');
const accountSockets = require('../lib/accountSockets');
const { jidVariants } = require('../lib/jid');

const REACTIONS = {
  menu: '📖', ping: '🏓', cancel: '✖️', paper: '📚', countpapers: '📚', refreshpapers: '📚',
  movie: '🎬', series: '📺', song: '🎵', video: '🎬',
  sticker: '🎨', viewonce: '👁️', info: '🔎', providers: '🔎',
  moviestatus: '📊', status: '📊', restart: '🔄', on: '⚙️', off: '⚙️',
  allow: '🔐', disallow: '🔐', listusers: '👥',
};

async function reactToCommand(sock, msg, from, name) {
  if (!msg?.key || !from) return;
  try { await sock.sendMessage(from, { react: { text: REACTIONS[name] || '📥', key: msg.key } }); }
  catch { /* reactions are best effort and must not prevent the command */ }
}

// Owners and hardcoded bot admins (matches PN or LID forms of the sender)
const isOwner = (ids, sessionDir = null) => {
  const sender = jidVariants(ids, sessionDir);
  if (!sender.size) return false;
  return [...config.ownerNumber, ...(config.adminNumbers || [])].some((n) => {
    const staff = jidVariants(`${n}@s.whatsapp.net`, sessionDir);
    return [...staff].some((x) => sender.has(x));
  });
};

// The configured owner only (admins excluded): for commands admins must not run
const isStrictOwner = (ids, sessionDir = null) => {
  const sender = jidVariants(ids, sessionDir);
  if (!sender.size) return false;
  return config.ownerNumber.some((n) => {
    const staff = jidVariants(`${n}@s.whatsapp.net`, sessionDir);
    return [...staff].some((x) => sender.has(x));
  });
};

const buildExtra = (sock, msg, { from, sender, senderIds, commandName = '' }) => ({
  from,
  sender,
  senderIds,
  commandName,
  sessionId: accountSockets.sessionKey(sock),
  isOwner: isOwner(senderIds, sock.__sessionDir),
  reply: (text) => sock.sendMessage(from, { text }, selections.quoteOpts(msg)),
  status: async (initialText) => {
    const sent = await sock.sendMessage(from, { text: initialText }, selections.quoteOpts(msg));
    return {
      update: async (finalText) => {
        try {
          return await sock.sendMessage(from, { text: finalText, edit: sent.key });
        } catch (e) {
          return sock.sendMessage(from, { text: finalText }, selections.quoteOpts(msg));
        }
      },
    };
  },
});

module.exports = { REACTIONS, reactToCommand, isOwner, isStrictOwner, buildExtra };
