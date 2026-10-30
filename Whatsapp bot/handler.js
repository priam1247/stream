/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('./config');
const database = require('./database');
const selections = require('./utils/selections');
const { loadCommands } = require('./utils/commandLoader');
const { jidVariants, isSystemJid } = require('./utils/jid');
const { safeErrorMessage } = require('./utils/userErrors');
const telemetry = require('./utils/telemetry');
const accountSockets = require('./utils/accountSockets');

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

// Owners and hardcoded bot admins (matches PN or LID forms of the sender)
const isOwner = (ids, sessionDir = null) => {
  const sender = jidVariants(ids, sessionDir);
  if (!sender.size) return false;
  return [...config.ownerNumber, ...(config.adminNumbers || [])].some(n => {
    const staff = jidVariants(`${n}@s.whatsapp.net`, sessionDir);
    return [...staff].some(x => sender.has(x));
  });
};

// Every command receives this bag of helpers.
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

  if (command.ownerOnly && !isOwner(senderIds, sock.__sessionDir)) {
    await sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    return true;
  }

  console.log(`Executing command: ${invoked}`);
  telemetry.recordCommand(command.name || invoked);
  try {
    await command.execute(
      sock,
      msg,
      args || [],
      buildExtra(sock, msg, { from, sender, senderIds, commandName: invoked }),
    );
  } catch (err) {
    telemetry.recordFailure('command');
    throw err;
  }
  return true;
}

// Tap-selector & "reply with a number" answers are resolved here.
async function handleSelection(sock, msg, body, { from, sender, senderIds, quotedMessageId = null }) {
  const opts = { quotedMessageId, rawText: body, scope: accountSockets.sessionKey(sock), sessionDir: sock.__sessionDir };
  const open = selections.peek(from, senderIds, opts);
  if (!open) return false;

  if (selections.isCancel(body)) {
    selections.clear(from, senderIds, opts);
    await sock.sendMessage(from, { text: '👍 Cancelled.' }, selections.quoteOpts(msg));
    return true;
  }

  const picked = selections.match(from, senderIds, body, opts);
  if (picked) {
    try {
      await picked.entry.run(sock, msg, buildExtra(sock, msg, { from, sender, senderIds }), picked.item);
    } catch (e) {
      telemetry.recordFailure('selection');
      console.error('Error running selection:', e.message);
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
  try {
    // Each socket serves only commands sent by its own WhatsApp account.
    if (!msg?.message || msg?.key?.fromMe !== true) return;
    if (isEditedMessage(msg)) return;
    // Linked accounts stop serving requests when their dashboard approval is paused.
    if (typeof sock.__canRespond === 'function' && !sock.__canRespond()) return;

    const from = msg.key.remoteJid;
    if (isSystemJid(from)) return;

    const content = getMessageContent(msg);
    if (!content) return;

    const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
    if (Object.keys(content).filter(k => !protocolMessages.includes(k)).length === 0) return;

    // Get message body from unwrapped content
    let body = '';
    if (content.conversation) {
      body = content.conversation;
    } else if (content.extendedTextMessage) {
      body = content.extendedTextMessage.text || '';
    } else if (content.imageMessage) {
      body = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
      body = content.videoMessage.caption || '';
    } else if (content.documentMessage) {
      body = content.documentMessage.caption || '';
    } else if (content.interactiveResponseMessage) {
      body = selections.extractInteractiveSelection(content);
    } else if (content.buttonsResponseMessage) {
      body = content.buttonsResponseMessage.selectedButtonId || '';
    } else if (content.listResponseMessage) {
      body = content.listResponseMessage.singleSelectReply?.selectedRowId || '';
    }
    body = (body || '').trim();

    // No bare links, poll votes, or plain-number replies: a prefix is required
    // even when continuing a previous selection (for example, .2 or .cancel).
    if (!body.startsWith(config.prefix)) return;
    const commandText = body.slice(config.prefix.length).trim();
    if (!commandText) return;

    // Never use the chat recipient's alternate JID to grant owner privileges.
    // Identity belongs to the current socket, not the contact or group.
    const sender = sock.__accountNumber ? `${sock.__accountNumber}@s.whatsapp.net` : sock.user?.id;
    if (!sender) return;
    const senderIds = [sender, sock.user?.id, sock.user?.lid].filter(Boolean);
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
    if (error.message && error.message.includes('rate-overlimit')) {
      console.warn('⚠️ Rate limit reached. Skipping error message.');
      return;
    }

    try {
      // Never leak stack traces, paths, or internal error text into the chat.
      const sender = sock.__accountNumber ? `${sock.__accountNumber}@s.whatsapp.net` : sock.user?.id;
      const senderIds = [sender, sock.user?.id, sock.user?.lid].filter(Boolean);
      await sock.sendMessage(msg.key.remoteJid, {
        text: safeErrorMessage(error, { isOwner: isOwner(senderIds, sock.__sessionDir) }),
      }, { quoted: msg });
    } catch (e) {
      if (!e.message || !e.message.includes('rate-overlimit')) {
        console.error('Error sending error message:', e);
      }
    }
  }
};

module.exports = {
  handleMessage,
  isEditedMessage,
  isSystemJid,
};
