'use strict';

/**
 * gateway/router.js — parse → guards → dispatch.
 *
 * Parse:      prefix, command trigger, arguments.
 * Guards:     gateway/guards.js, in the spec's exact order.
 * Dispatch:   gateway/runner.js, one child process, hard timeout, then status
 *             and the circuit breaker.
 *
 * The router is deliberately free of feature logic. It knows about messages,
 * commands-as-units and outcomes. It does not know what a song is.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jid = require('../lib/jid');
const config = require('./config');
const registry = require('./registry');
const guards = require('./guards');
const dedupe = require('./dedupe');
const runner = require('./runner');
const status = require('./status');
const ctxBuilder = require('./ctx');
const store = require('./users/store');
const adminApi = require('./admin');
const usage = require('./users/usage');
const { gatewayLog } = require('./log');
const { paths, commandJobDir } = require('../lib/paths');
const { ensureDir } = require('../lib/fsutil');

const CONTAINER_KEYS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
  'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'deviceSentMessage',
];

/** Unwrap WhatsApp's envelope shapes. Edited messages are rejected upstream. */
function unwrap(message) {
  let m = message?.message;
  for (let i = 0; i < 5 && m; i++) {
    const key = CONTAINER_KEYS.find((k) => m[k]?.message);
    if (!key) break;
    m = m[key].message;
  }
  return m || null;
}

function isEdited(message) {
  let m = message?.message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.editedMessage) return true;
    if (m.protocolMessage?.editedMessage || m.protocolMessage?.type === 14) return true;
    const key = CONTAINER_KEYS.find((k) => m[k]?.message);
    if (!key) break;
    m = m[key].message;
  }
  return false;
}

/**
 * @returns {{trigger:string, args:string[], text:string}|null}
 */
function parse(message, prefix) {
  const body = ctxBuilder.extractText(message);
  if (!body || !body.startsWith(prefix)) return null;
  const commandText = body.slice(prefix.length).trim();
  if (!commandText) return null;
  const parts = commandText.split(/\s+/);
  const trigger = String(parts.shift() || '').toLowerCase();
  if (!trigger) return null;
  return { trigger, args: parts, text: parts.join(' ') };
}

/* ── transports ──────────────────────────────────────────────────────────── */

function fileTypeFor(kind) {
  return {
    image: 'image', video: 'video', audio: 'audio', document: 'document',
  }[kind];
}

/**
 * Performs one send request coming from a child process. This is the only place
 * a command's intent turns into a Baileys call.
 */
async function transport(sock, message, kind, payload, { deleteAfter = true } = {}) {
  const chat = payload.chat || message.key.remoteJid;

  if (kind === 'text') {
    const sent = await sock.sendMessage(chat, { text: payload.text }, { quoted: message });
    dedupe.rememberSend(sent?.key?.id);
    return sent;
  }
  if (kind === 'react') {
    const sent = await sock.sendMessage(chat, { react: { text: payload.emoji, key: message.key } });
    dedupe.rememberSend(sent?.key?.id);
    return sent;
  }

  const type = fileTypeFor(kind);
  if (!type) throw new Error(`unknown send kind: ${kind}`);
  if (!payload.path || !fs.existsSync(payload.path)) {
    throw new Error(`${kind} file disappeared before sending: ${payload.path}`);
  }

  const content = { [type]: fs.readFileSync(payload.path) };
  if (payload.caption) content.caption = payload.caption;
  if (type === 'document') {
    content.fileName = payload.filename || path.basename(payload.path);
    content.mimetype = 'application/octet-stream';
  } else if (type === 'audio') {
    content.mimetype = 'audio/mpeg';
  }

  try {
    const sent = await sock.sendMessage(chat, content, { quoted: message });
    dedupe.rememberSend(sent?.key?.id);
    return sent;
  } finally {
    if (deleteAfter) {
      try { fs.unlinkSync(payload.path); } catch { /* send already consumed it */ }
    }
  }
}

/* ── dispatch ────────────────────────────────────────────────────────────── */

/**
 * The data view of the registry that read-only commands (menu, status) need.
 * Plain objects only; no functions, no registry internals.
 */
function catalogueRows() {
  const board = status.snapshot();
  return registry.list().map((entry) => ({
    name: entry.name,
    aliases: entry.meta.aliases,
    category: entry.meta.category,
    description: entry.meta.description,
    usage: entry.meta.usage,
    role: entry.meta.role,
    // The state travels with the row so `.menu` can mark a broken or disabled
    // command instead of advertising it as if it worked. This is the "a broken
    // command is visibly identifiable" goal, applied where users look first.
    state: board[entry.name]?.state || 'unknown',
    stateReason: board[entry.name]?.reason || '',
  }));
}

const lanes = { light: 0, heavy: 0, single: 0 };

function laneAvailable(lane) {
  // 'single' is a single-slot lane: movie and series can never run concurrently,
  // which is what keeps one 2 GB download from starving the host.
  if (lane === 'single') return lanes.single === 0;
  return true;
}

/**
 * @param {object} args
 * @param {string} args.number  linked number that owns this socket
 * @param {object} args.sock    Baileys socket (never leaves the gateway)
 * @param {object} args.message raw WAMessage
 * @param {(text:string)=>void} [args.onRefusal]
 */
async function handle({ number, sock, message, onRefusal, linked = [] }) {
  if (!message?.message) return { handled: false, reason: 'no-message' };
  if (isEdited(message)) return { handled: false, reason: 'edited-message' };

  // Our own reply arriving on one of our other sockets. Dropping it here is what
  // stops session B from trying to execute session A's answer.
  if (dedupe.isOwnSend(message.key?.id)) {
    return { handled: false, reason: 'own-echo' };
  }

  const unwrapped = unwrap(message);
  if (!unwrapped) return { handled: false, reason: 'empty-content' };

  const settings = store.readSettings(number);
  const prefix = settings.prefix || config.prefix;

  const parsed = parse(message, prefix);
  if (!parsed) return { handled: false, reason: 'no-prefix' };

  const command = registry.get(parsed.trigger);
  if (!command) {
    // Unknown commands are ignored, exactly as the old bot did.
    return { handled: false, reason: 'unknown-command', trigger: parsed.trigger };
  }

  // In a group the sender is `participant`; in a DM it is the other party, which
  // is the chat jid itself. Never `remoteJid` for a group, or every member would
  // look like the same person.
  const chat = message.key.remoteJid || '';
  const isGroup = chat.endsWith('@g.us');
  // `linked` contains our own numbers. A message from one of them is "us", even
  // when it arrives with fromMe false on another socket.
  const ownNumbers = linked.map(String);
  const senderRaw = isGroup
    ? message.key.participant
    : (message.key.fromMe ? `${number}@s.whatsapp.net` : chat);
  const senderDigits = jid.digits(senderRaw);
  const senderIsOurs = ownNumbers.includes(senderDigits) || (message.key.fromMe === true && !isGroup);

  // A group must be switched on before the bot will say anything in it.
  const settingsForGroup = store.readSettings(number);
  const groupEnabled = isGroup
    ? (settingsForGroup.groups || []).includes(chat)
    : true;

  // Exactly one socket answers when several of our numbers share the chat.
  const responder = dedupe.claimResponder({
    id: message.key?.id,
    sender: senderDigits,
    number,
    linked: ownNumbers,
  });
  if (!responder.respond) {
    gatewayLog.debug('not the responding socket', { reason: responder.reason, chat });
    return { handled: false, reason: responder.reason };
  }

  const decision = guards.evaluate({
    message: {
      fromMe: senderIsOurs,
      isGroup,
      groupEnabled,
      chatKind: isGroup ? 'group' : 'dm',
      chat,
      sender: senderRaw,
    },
    number,
    command,
    linked: ownNumbers,
  });

  if (decision.mode === guards.MODE.IGNORE) {
    gatewayLog.debug('ignored', { command: command.name, reason: decision.reason });
    return { handled: true, refused: true, reason: decision.reason };
  }

  if (decision.mode === guards.MODE.NOT_AUTHORIZED) {
    const text = guards.refusalText(decision.reason, decision);
    try {
      const sent = await sock.sendMessage(message.key.remoteJid, { text }, { quoted: message });
      dedupe.rememberSend(sent?.key?.id);
    } catch (err) {
      gatewayLog.warn('could not send refusal', { error: err.message });
    }
    onRefusal?.(decision.reason);
    return { handled: true, refused: true, reason: decision.reason };
  }

  // ⛔ disabled: admin toggle or tripped breaker. Never runs, always explains.
  if (status.isDisabled(command.name)) {
    try {
      const sent = await sock.sendMessage(message.key.remoteJid, {
        text: `⛔ .${command.name} is disabled (${status.snapshot()[command.name]?.reason || 'disabled'}).`,
      }, { quoted: message });
      dedupe.rememberSend(sent?.key?.id);
    } catch (err) {
      gatewayLog.warn('could not send disabled notice', { error: err.message });
    }
    return { handled: true, refused: true, reason: 'disabled' };
  }

  if (!laneAvailable(command.meta.lane)) {
    try {
      await sock.sendMessage(message.key.remoteJid, {
        text: `⏳ .${command.name} is busy with another job. Try again in a moment.`,
      }, { quoted: message });
    } catch (err) {
      gatewayLog.warn('could not send busy notice', { error: err.message });
    }
    return { handled: true, refused: true, reason: 'lane-busy' };
  }

  return dispatch({ number, sock, message, command, parsed });
}

/**
 * Media download for commands that need bytes (sticker, viewonce).
 *
 * Only the gateway holds the socket, so only the gateway can fetch media. The
 * command supplies a destination path inside its own job folder; the gateway
 * writes the file and deletes it if the write fails.
 */
async function downloadTransport(sock, message, payload) {
  const dest = payload?.path;
  if (!dest || !String(dest).startsWith(paths.tmp)) {
    throw new Error('media destination must be inside storage/tmp');
  }
  const source = message?.__quotedRaw || message?.message;
  if (!source) throw new Error('no message to download media from');

  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  const buffer = await downloadMediaMessage(
    { key: message.key, message: source },
    'buffer',
    {},
    { logger: undefined, reuploadRequest: sock.updateMediaMessage },
  );
  if (!buffer || !buffer.length) throw new Error('the media download produced no bytes');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { bytes: buffer.length, path: dest };
}

/**
 * Transports that are not sends. Kept beside the send transport so a child has
 * exactly one door back into the gateway.
 */
async function adminTransport({ number, message }, request) {
  const sender = jid.digits(message.key.participant || message.key.remoteJid) || number;
  return adminApi.apply({
    number,
    sender,
    request: {
      ...request,
      sessions: request?.sessions || sessionSnapshot(),
      requestPairing,
    },
  });
}

let sessionSnapshot = () => [];
let requestPairing = null;
function setSessionSnapshot(fn) { sessionSnapshot = fn; }
function setRequestPairing(fn) { requestPairing = fn; }

async function dispatch({ number, sock, message, command, parsed }) {
  const jobId = crypto.randomBytes(6).toString('hex');
  const { ctx, jobDir } = ctxBuilder.build({
    number, message, command, argv: parsed.args, text: parsed.text, jobId,
    catalogue: catalogueRows(),
    statuses: status.snapshot(),
  });

  ensureDir(jobDir);
  usage.mark(number, ctx.sender.number, command.name);
  lanes[command.meta.lane] = (lanes[command.meta.lane] || 0) + 1;

  const logLines = [];
  let outcome;
  try {
    outcome = await runner.run({
      name: command.name,
      folderPath: command.folderPath,
      timeoutSec: command.meta.timeoutSec,
      ctx,
      transport: (kind, payload) => {
        if (kind === 'admin') return adminTransport({ number, message }, payload.request);
        if (kind === 'download') return downloadTransport(sock, message, payload);
        return transport(sock, message, kind, payload);
      },
      onLog: (level, text) => logLines.push({ level, text }),
    });
  } finally {
    lanes[command.meta.lane] = Math.max(0, (lanes[command.meta.lane] || 1) - 1);
    // Belt and braces: the child removes its own job folder, but a killed child
    // never reaches its finally block.
    try { fs.rmSync(commandJobDir(command.name, jobId), { recursive: true, force: true }); } catch { /* already gone */ }
  }

  // Child log lines land in logs/<command>.log with the gateway's own logger.
  for (const line of logLines) {
    gatewayLog.debug(`[${command.name}] ${line.text}`, { level: line.level });
  }

  try {
    store.recordCommandUse(number, ctx.sender.number, command.name);
  } catch (err) {
    gatewayLog.warn('usage counter failed', { command: command.name, error: err.message });
  }

  if (outcome.ok) {
    status.markOk(command.name, { source: 'run' });
    return { handled: true, ok: true, command: command.name, durationMs: outcome.durationMs };
  }

  status.markBroken(command.name, outcome.error.message, { source: 'run' });
  const tripped = status.recordCrash(command.name);

  try {
    await sock.sendMessage(message.key.remoteJid, {
      text: `⚠️ .${command.name} is down. Please try again later.`,
    }, { quoted: message });
  } catch (err) {
    gatewayLog.warn('could not send failure notice', { error: err.message });
  }

  if (tripped) {
    await notifyOwner(sock, number, command.name, outcome.error.message);
  }

  return {
    handled: true,
    ok: false,
    command: command.name,
    reason: outcome.error.message,
    tripped,
    durationMs: outcome.durationMs,
  };
}

/**
 * Owner notification for the circuit breaker. Best effort: a failed notice must
 * not throw inside the router.
 */
async function notifyOwner(sock, number, commandName, reason) {
  const owner = store.readOwner();
  if (!owner) {
    gatewayLog.warn('breaker tripped but no owner is set; nobody to notify', { command: commandName });
    return;
  }
  try {
    await sock.sendMessage(jid.toJid(owner), {
      text: `⛔ .${commandName} disabled by the circuit breaker after 3 crashes.\nLast error: ${reason}`,
    });
  } catch (err) {
    gatewayLog.warn('could not notify owner', { error: err.message });
  }
  void number;
  void paths;
}

module.exports = {
  handle,
  parse,
  unwrap,
  isEdited,
  transport,
  adminTransport,
  downloadTransport,
  setSessionSnapshot,
  setRequestPairing,
  catalogueRows,
  lanes,
};
