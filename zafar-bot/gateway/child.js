'use strict';

/**
 * gateway/child.js — the command's whole world.
 *
 * One process, one command invocation. It receives a plain-data ctx, builds the
 * real ctx object (with functions), requires the command's index.js from inside
 * its own folder, calls run(), then exits.
 *
 * Rules enforced here by construction:
 *   - the command cannot reach a Baileys socket: `sock` is never passed in
 *   - the command cannot write users.json: the path is not in its env and the
 *     store is not reachable from its folder
 *   - every send is an IPC request; the gateway performs it
 *   - the job folder is deleted in the finally block, success or failure
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ── IPC helpers ─────────────────────────────────────────────────────────── */

let seq = 0;
const pending = new Map();

function call(kind, payload) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: 'send', id, kind, payload });
  });
}

process.on('message', (msg) => {
  if (!msg || msg.type !== 'result') return;
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.ok) waiter.resolve(msg.value);
  else waiter.reject(new Error(msg.error || 'send failed'));
});

/* ── ctx construction ────────────────────────────────────────────────────── */

function makeLogger(name, level) {
  const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
  const min = LEVELS[level] || LEVELS.info;
  const emit = (lvl, message) => {
    if (LEVELS[lvl] < min) return;
    try {
      process.send({ type: 'log', level: lvl, message: String(message).slice(0, 4000) });
    } catch {
      // The gateway is gone; nothing useful left to do with the line.
    }
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

function buildCtx(raw) {
  const log = makeLogger(raw.command, raw.logLevel);

  const send = {
    text: (text) => call('text', { text: String(text ?? '') }),
    image: (file, caption) => call('image', { path: file, caption }),
    video: (file, caption) => call('video', { path: file, caption }),
    audio: (file, caption) => call('audio', { path: file, caption }),
    document: (file, caption, filename) => call('document', { path: file, caption, filename }),
  };

  // Frozen copies: commands get read-only views, and mutating the local copy
  // cannot affect the gateway's state.
  const user = raw.user ? Object.freeze({ ...raw.user }) : null;
  const settings = Object.freeze({ ...raw.settings });

  return Object.freeze({
    args: Object.freeze([...raw.args]),
    text: raw.text,
    command: raw.command,
    prefix: raw.prefix,
    sender: Object.freeze({ ...raw.sender }),
    user,
    role: raw.role,
    chat: raw.chat,
    // Which linked number received this message. Every per-number lookup the
    // user sees (users list, settings) is scoped by it.
    number: raw.number,
    isGroup: Boolean(raw.isGroup),
    quoted: raw.quoted || null,
    settings,
    tmp: raw.tmp,
    limits: Object.freeze({ ...(raw.limits || {}) }),
    // Read-only data views handed in by the gateway: the catalogue for .menu and
    // the status board for .status. Plain objects, never registry internals.
    catalogue: Object.freeze((raw.catalogue || []).map((row) => Object.freeze({ ...row }))),
    statuses: Object.freeze({ ...(raw.statuses || {}) }),
    log,
    reply: (text) => call('text', { text: String(text ?? '') }),
    send: Object.freeze(send),
    react: (emoji) => call('react', { emoji: String(emoji) }),
    /**
     * Admin commands only. The gateway authorises and applies the change; the
     * command never sees users.json and cannot write it.
     */
    admin: (request) => call('admin', { request }),
    /**
     * Fetch the quoted message's media into `dest` (must be inside ctx.tmp) and
     * return { bytes, path }. Commands that manipulate media use this.
     */
    download: (dest) => call('download', { path: dest }),
  });
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  const raw = JSON.parse(process.env.ZAFAR_CTX || '{}');
  const folder = process.env.ZAFAR_COMMAND_DIR;
  const jobDir = raw.tmp;

  const cleanupJob = () => {
    if (!jobDir) return;
    try {
      if (!jobDir.split(path.sep).join('/').includes('/storage/tmp/')) return;
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (err) {
      try { process.send({ type: 'log', level: 'warn', message: `job cleanup failed: ${err.message}` }); } catch { /* gone */ }
    }
  };

  let code = 0;
  try {
    const ctx = buildCtx(raw);
    const commandPath = path.join(folder, 'index.js');
    const mod = require(commandPath);
    if (!mod || typeof mod.run !== 'function') {
      throw new Error('index.js must export run(ctx)');
    }
    const result = await mod.run(ctx);
    process.send({ type: 'done', result: result === undefined ? null : result });
  } catch (err) {
    // A syntax error or a top-level throw must surface as a loud, specific
    // failure. The class name + first line is the useful part (e.g.
    // "SyntaxError: Unexpected identifier 'is'"); the rest goes to stderr.
    const name = err?.name || 'Error';
    const first = String(err?.message || err).split('\n')[0].trim();
    const message = `${name}: ${first}`;
    try {
      process.send({ type: 'log', level: 'error', message: `run(ctx) failed: ${message}` });
    } catch { /* gone */ }
    // Write to stderr too: the gateway reads it when the child exits abnormally.
    try {
      process.stderr.write(`${message}\n`);
      if (err?.stack) process.stderr.write(`${err.stack}\n`);
    } catch { /* gone */ }
    code = 1;
    process.exitCode = code;
  } finally {
    cleanupJob();
    // Give the IPC socket a tick to flush the final message before exiting.
    setTimeout(() => process.exit(code), 25);
  }
}

process.send({ type: 'ready' });
main().catch((err) => {
  try { process.send({ type: 'log', level: 'error', message: `fatal: ${err.stack || err}` }); } catch { /* gone */ }
  process.exit(1);
});

// Deterministic job id helper exposed for commands that need one.
module.exports = { jobId: () => crypto.randomBytes(6).toString('hex') };
