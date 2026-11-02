'use strict';

/**
 * gateway/ctx.js — builds the ctx the gateway hands to runner.js.
 *
 * The only API a command sees, per docs/ARCHITECTURE.md:
 *
 *   fields   args, text, command, prefix, sender{number,name}, user, role, chat,
 *            isGroup, quoted, settings, tmp, limits, log
 *   methods  reply(text), send.text/image/video/audio/document, react(emoji)
 *
 * This module is the ONLY place that knows which Baileys shapes exist. If
 * Baileys changes, this file changes and nothing under commands/ does.
 */

const path = require('path');
const jid = require('../lib/jid');
const { commandJobDir } = require('../lib/paths');
const store = require('./users/store');
const admin = require('./admin');
const config = require('./config');

/** Pull a usable text body out of any Baileys message shape. */
function extractText(message) {
  const m = message?.message;
  if (!m) return '';
  const keys = [
    ['conversation', null],
    ['extendedTextMessage', 'text'],
    ['imageMessage', 'caption'],
    ['videoMessage', 'caption'],
    ['documentMessage', 'caption'],
  ];
  for (const [outer, inner] of keys) {
    if (!m[outer]) continue;
    const value = inner ? m[outer][inner] : m[outer];
    if (typeof value === 'string' && value.trim()) return value;
  }
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedButtonId || '';
  if (m.listResponseMessage) return m.listResponseMessage.singleSelectReply?.selectedRowId || '';
  return '';
}

/** The quoted message, reduced to what a command may know about it. */
function extractQuoted(message) {
  const m = message?.message;
  const contextInfo = m?.extendedTextMessage?.contextInfo
    || m?.imageMessage?.contextInfo
    || m?.videoMessage?.contextInfo
    || m?.documentMessage?.contextInfo
    || m?.buttonsResponseMessage?.contextInfo
    || null;

  if (!contextInfo?.quotedMessage) return null;

  const quoted = contextInfo.quotedMessage;
  const type = Object.keys(quoted).find((k) => k !== 'messageContextInfo') || 'unknown';
  const inner = quoted[type] || {};

  return {
    id: contextInfo.stanzaId || null,
    type,
    text: typeof inner === 'string' ? inner : (inner.caption || inner.text || ''),
    mediaType: type.replace('Message', ''),
    // Media *download* stays inside the command: it needs Baileys, and the
    // command is where that belongs. See commands/viewonce and commands/sticker.
    raw: quoted,
  };
}

function isGroupChat(chat) {
  return jid.isGroup(chat);
}

/**
 * @param {object} args
 * @param {string} args.number    linked number that received the message
 * @param {object} args.message   raw Baileys WAMessage
 * @param {object} args.command   registry entry
 * @param {string[]} args.argv    parsed arguments (no command name)
 * @param {string} args.text      full argument text
 * @param {string} [args.jobId]
 * @returns {{ctx:object, jobDir:string, transportTarget:object}}
 */
function build({ number, message, command, argv, text, jobId, catalogue, statuses }) {
  const chat = message?.key?.remoteJid || '';
  const senderJid = message?.key?.participant || message?.key?.remoteJid || '';
  const senderNumber = jid.digits(senderJid) || number;
  const settings = store.readSettings(number);
  const user = store.getUser(number, senderNumber);

  const dir = commandJobDir(command.name, jobId);

  const ctx = {
    args: argv,
    text,
    command: command.name,
    prefix: settings.prefix || config.prefix,
    sender: {
      number: senderNumber,
      name: user?.name || '',
    },
    // Read-only snapshot. A command that needs to change this is wrong.
    user: user
      ? {
        number: user.number,
        name: user.name,
        role: user.role,
        status: user.status,
        joinedAt: user.joinedAt,
      }
      : null,
    role: store.effectiveRole(number, store.listUsers(number)) || (user ? user.role : 'user'),
    chat,
    isGroup: isGroupChat(chat),
    quoted: extractQuoted(message),
    settings: {
      accessMode: settings.accessMode,
      maintenance: settings.maintenance,
      prefix: settings.prefix,
    },
    tmp: dir,
    limits: command.meta.limits || {},
    number,
    // Live registry view, so .menu lists what actually loaded. Data only: a
    // command cannot reach the registry object itself.
    catalogue: Array.isArray(catalogue) ? catalogue : [],
    statuses: statuses || {},
  };

  return { ctx, jobDir: dir };
}

module.exports = { build, extractText, extractQuoted, isGroupChat };
