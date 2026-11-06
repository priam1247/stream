/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('../config');
const database = require('../lib/database');
const selections = require('../lib/selections');
const { loadCommands } = require('./registry');
const { isSystemJid } = require('../lib/jid');
const { safeErrorMessage } = require('../lib/userErrors');
const telemetry = require('../lib/telemetry');
const memberTelemetry = require('./users/usage');
const accountSockets = require('../lib/accountSockets');
const memberCommandPolicy = require('./users/policy');
const log = require('../lib/logger')('commands');
const guards = require('./guards');
const registry = require('./registry');
const { reactToCommand, isOwner, isStrictOwner, buildExtra } = require('./ctx');

// A command that never settles must not hold a chat forever; it counts as a
// failure toward the circuit breaker. Commands may export their own timeoutMs.
const DEFAULT_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS) || 30 * 60 * 1000;

// Load all commands
const commands = loadCommands();

// Unwrap WhatsApp containers (ephemeral, view once, …).
// Deliberately excludes `editedMessage`: edited messages must NOT re-trigger commands.
const CONTAINER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
];

const isEditedMessage = (msg) => {
  if (!msg || !msg.message) return false;
  let m = msg.message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.editedMessage) return true;
    if (m.protocolMessage?.editedMessage || m.protocolMessage?.type === 14) return true;
    const nextKey = CONTAINER_KEYS.find((k) => m[k] && m[k].message);
    if (!nextKey) break;
    m = m[nextKey].message;
  }
  return false;
};

const getMessageContent = (msg) => {
  if (!msg || !msg.message) return null;
  let m = msg.message;
  for (let i = 0; i < 5; i++) {
    const key = CONTAINER_KEYS.find(k => m && m[k] && m[k].message);
    if (!key) break;
    m = m[key].message;
  }
  return m || null;
};

// Text, caption or tap-selection id of an unwrapped message.
const extractBody = (content) => {
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage) return content.extendedTextMessage.text || '';
  if (content.imageMessage) return content.imageMessage.caption || '';
  if (content.videoMessage) return content.videoMessage.caption || '';
  if (content.documentMessage) return content.documentMessage.caption || '';
  if (content.interactiveResponseMessage) return selections.extractInteractiveSelection(content);
  if (content.buttonsResponseMessage) return content.buttonsResponseMessage.selectedButtonId || '';
  if (content.listResponseMessage) return content.listResponseMessage.singleSelectReply?.selectedRowId || '';
  return '';
};

// Extract the stanzaId of any message quoted by `content`, if present.
const getQuotedMessageId = (content) =>
  content?.extendedTextMessage?.contextInfo?.stanzaId ||
  content?.interactiveResponseMessage?.contextInfo?.stanzaId ||
  content?.buttonsResponseMessage?.contextInfo?.stanzaId ||
  content?.listResponseMessage?.contextInfo?.stanzaId ||
  content?.imageMessage?.contextInfo?.stanzaId ||
  content?.videoMessage?.contextInfo?.stanzaId ||
  content?.documentMessage?.contextInfo?.stanzaId ||
  null;

// Execute an explicitly prefixed command. Unknown commands are ignored.
async function runCommand(sock, msg, name, args, { from, sender, senderIds }) {
  const invoked = String(name || '').toLowerCase();
  const command = commands.get(invoked);
  if (!command) return false;

  // ownerOnly = the configured owner only; admins get just the commands marked adminOk.
  if (command.ownerOnly && !isStrictOwner(senderIds, sock.__sessionDir) &&
      !(command.adminOk && isOwner(senderIds, sock.__sessionDir))) {
    await sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    return true;
  }

  if (!isOwner(senderIds, sock.__sessionDir) && memberCommandPolicy.isUnavailable(command.name || invoked)) {
    await sock.sendMessage(from, { text: 'This command is temporarily unavailable. Please try again later.' }, selections.quoteOpts(msg));
    return true;
  }

  if (registry.disabledInfo(command.name || invoked)) {
    await sock.sendMessage(from, { text: `⛔ .${command.name || invoked} is switched off. Try again later.` }, selections.quoteOpts(msg));
    return true;
  }

  // The console shows every command: who ran it, where, and how it ended.
  const label = `.${command.name || invoked}`;
  const who = String(sender || (Array.isArray(senderIds) ? senderIds[0] : '') || '').replace(/\D/g, '') || 'unknown';
  const where = String(from || '').endsWith('@g.us') ? 'group' : 'DM';
  const preview = (Array.isArray(args) ? args : []).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  log.info(`${label} ← ${who} (${where})${preview ? ` ${preview}` : ''}`);
  const startedAt = Date.now();
  const took = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  // These XJX-style handlers react at the same point as their source; do not
  // add the generic command reaction as a duplicate.
  if (!['song', 'video', 'dramabox'].includes(command.name)) await reactToCommand(sock, msg, from, command.name || invoked);
  telemetry.recordCommand(command.name || invoked);
  try { memberTelemetry.recordCommand(command.name || invoked, sock.__memberUsageScope?.()); }
  catch { /* personal analytics must not interrupt command execution */ }
  const timeoutMs = Number(command.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let timer;
  try {
    await Promise.race([
      command.execute(
        sock,
        msg,
        args || [],
        buildExtra(sock, msg, { from, sender, senderIds, commandName: invoked }),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`.${command.name || invoked} timed out`), { code: 'COMMAND_TIMEOUT' })), timeoutMs);
      }),
    ]);
  } catch (err) {
    log.warn(`${label} ✗ ${took()} (${String(err?.code || err?.message || 'failed').slice(0, 120)})`);
    telemetry.recordFailure('command');
    // Crash isolation: only this command's folder is counted and, after
    // repeated failures, switched off. Everything else keeps running.
    try {
      if (registry.recordFailure(command.name || invoked)) {
        log.warn(`.${command.name || invoked} switched off after repeated failures`);
        await sock.sendMessage(from, { text: `⛔ .${command.name || invoked} keeps failing and was switched off. Owner can re-enable with .on ${command.name || invoked}` }, selections.quoteOpts(msg));
      }
    } catch { /* breaker notices are best effort */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  registry.recordSuccess(command.name || invoked);
  log.info(`${label} ✓ ${took()}`);
  return true;
}

// Tap-selector & "reply with a number" answers are resolved here.
async function handleSelection(sock, msg, body, { from, sender, senderIds, quotedMessageId = null }) {
  const opts = { quotedMessageId, rawText: body, scope: accountSockets.sessionKey(sock), sessionDir: sock.__sessionDir };
  const open = selections.peek(from, senderIds, opts);
  if (!open) return false;

  if (selections.isCancel(body)) {
    selections.clear(from, senderIds, opts);
    await reactToCommand(sock, msg, from, 'cancel');
    await sock.sendMessage(from, { text: '👍 Cancelled.' }, selections.quoteOpts(msg));
    return true;
  }

  const picked = selections.match(from, senderIds, body, opts);
  if (picked) {
    const originatingName = picked.entry.commandName || '';
    const canonicalName = commands.get(originatingName)?.name || originatingName;
    if (!isOwner(senderIds, sock.__sessionDir) && memberCommandPolicy.isUnavailable(canonicalName)) {
      await sock.sendMessage(from, { text: 'This command is temporarily unavailable. Please try again later.' }, selections.quoteOpts(msg));
      return true;
    }
    await reactToCommand(sock, msg, from, canonicalName);
    try {
      await picked.entry.run(sock, msg, buildExtra(sock, msg, { from, sender, senderIds, commandName: originatingName }), picked.item);
    } catch (e) {
      telemetry.recordFailure('selection');
      console.error('Error running selection:', e?.message || e);
      try {
        await sock.sendMessage(
          from,
          { text: safeErrorMessage(e, { isOwner: isOwner(senderIds, sock.__sessionDir) }) },
          selections.quoteOpts(msg),
        );
      } catch { /* ignore */ }
    }
    return true;
  }

  if (selections.isOutOfRange(from, senderIds, body, opts)) {
    await sock.sendMessage(from, {
      text: `Reply *${config.prefix}1*–*${config.prefix}${open.items.length}* or *${config.prefix}cancel*.`,
    }, selections.quoteOpts(msg));
    return true;
  }

  return false;
}

// Main message handler
const handleMessage = async (sock, msg) => {
  let mayReply = false;
  let guestIds = null;
  try {
    // Each socket serves only commands sent by its own approved WhatsApp
    // account (see gateway/guards.js): sender-only, approved-only, and a
    // message is claimed by exactly one socket, so group members never overlap.
    if (!msg?.message) return;
    if (isEditedMessage(msg)) return;
    // Allowed users are answered only in groups, by the number that allowed them.
    let guest = null;
    if (msg.key?.fromMe !== true) {
      // Cheap pre-check: other people's messages without the prefix are dropped
      // before any whitelist lookup, so busy groups cost nothing.
      const pre = getMessageContent(msg);
      if (!pre || !String(extractBody(pre) || '').trim().startsWith(config.prefix)) return;
      guest = guards.evaluateAllowedUser(sock, msg);
      if (!guest.allow) return;
      guestIds = guest.senderIds;
    } else if (!guards.evaluate(sock, msg).allow) return;

    const from = msg.key.remoteJid;
    if (isSystemJid(from)) return;

    const content = getMessageContent(msg);
    if (!content) return;

    const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
    if (Object.keys(content).filter(k => !protocolMessages.includes(k)).length === 0) return;

    // Get message body from unwrapped content
    let body = extractBody(content);
    body = (body || '').trim();

    // No bare links, poll votes, or plain-number replies: a prefix is required
    // even when continuing a previous selection (for example, .2 or .cancel).
    if (!body.startsWith(config.prefix)) return;
    const commandText = body.slice(config.prefix.length).trim();
    if (!commandText) return;

    // Never use the chat recipient's alternate JID to grant owner privileges.
    // Identity belongs to the current socket, not the contact or group.
    const sender = guest ? guest.sender : (sock.__accountNumber ? `${sock.__accountNumber}@s.whatsapp.net` : sock.user?.id);
    if (!sender) return;
    const senderIds = guest ? guest.senderIds : [sender, sock.user?.id, sock.user?.lid].filter(Boolean);
    if (!database.getBotState() && !isOwner(senderIds, sock.__sessionDir)) return;
    mayReply = true;
    const quotedMessageId = getQuotedMessageId(content);
    if (await handleSelection(sock, msg, commandText, { from, sender, senderIds, quotedMessageId })) return;

    const args = commandText.split(/\s+/);
    await runCommand(sock, msg, args.shift(), args, { from, sender, senderIds });

  } catch (error) {
    console.error('Error in message handler:', error);
    // A malformed or unauthorized message must not produce even an error reply.
    if (!mayReply) return;

    // Don't send error messages for rate limit errors
    if (error?.message?.includes('rate-overlimit')) {
      console.warn('⚠️ Rate limit reached. Skipping error message.');
      return;
    }

    try {
      // Never leak stack traces, paths, or internal error text into the chat.
      const sender = sock.__accountNumber ? `${sock.__accountNumber}@s.whatsapp.net` : sock.user?.id;
      const senderIds = guestIds || [sender, sock.user?.id, sock.user?.lid].filter(Boolean);
      await sock.sendMessage(msg.key.remoteJid, {
        text: safeErrorMessage(error, { isOwner: isOwner(senderIds, sock.__sessionDir) }),
      }, { quoted: msg });
    } catch (e) {
      if (!e?.message?.includes('rate-overlimit')) {
        console.error('Error sending error message:', e);
      }
    }
  }
};

/** Reload one command folder (used by `.restart <command>`); nothing else is touched. */
const reloadCommand = (name) => registry.reloadFolder(name, commands);

module.exports = {
  handleMessage,
  reloadCommand,
  isEditedMessage,
  isSystemJid,
};
