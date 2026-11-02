'use strict';

/**
 * lib/send.js — sending plus job-folder cleanup. Nothing else.
 *
 * The transport is injected: a command never sees Baileys. In a child process
 * the transport is an IPC relay to the gateway; in tests it is a fake.
 *
 * Cleanup contract (rule 7):
 *   - each media send deletes its own file after the send resolves or throws
 *   - `cleanupJob()` removes the entire  storage/tmp/<name>/<job>/  directory
 *     and is called from the child's finally block, so partial leftovers from
 *     a crash inside the command are removed too
 *   - it never touches storage/commands/*, storage/core/* or sessions/
 */

const fs = require('fs');
const path = require('path');

const PROTECTED_PREFIXES = ['storage/commands', 'storage/core', 'sessions', 'logs'];

function isProtected(dir) {
  const rel = dir.split(path.sep).join('/');
  return PROTECTED_PREFIXES.some((p) => rel === p || rel.endsWith('/' + p) || rel.includes('/' + p + '/'));
}

function assertJobDir(dir) {
  const rel = dir.split(path.sep).join('/');
  const marker = '/storage/tmp/';
  if (!rel.includes(marker)) {
    throw new Error(`refusing to delete a folder outside storage/tmp: ${dir}`);
  }
  if (isProtected(dir)) {
    throw new Error(`refusing to delete a protected folder: ${dir}`);
  }
}

function removeQuietly(target, log) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    log?.(`cleanup failed for ${target}: ${err.message}`);
  }
}

/**
 * @param {object} opts
 * @param {(kind:string, payload:object)=>Promise<any>} opts.transport
 * @param {string} opts.jobDir            storage/tmp/<name>/<job>
 * @param {(line:string)=>void} [opts.log]
 */
function createSender({ transport, jobDir, log }) {
  assertJobDir(jobDir);
  const sentFiles = new Set();

  async function deliver(kind, payload) {
    const result = await transport(kind, payload);
    const file = payload?.path;
    if (file) {
      sentFiles.add(file);
      // The file has been handed to WhatsApp; it is dead weight on disk.
      removeQuietly(file, log);
    }
    return result;
  }

  return {
    text: (text) => transport('text', { text: String(text ?? '') }),
    text_to: (text, chat) => transport('text', { text: String(text ?? ''), chat }),
    image: (file, caption) => deliver('image', { path: file, caption }),
    video: (file, caption) => deliver('video', { path: file, caption }),
    audio: (file, caption) => deliver('audio', { path: file, caption }),
    document: (file, caption, filename) => deliver('document', { path: file, caption, filename }),
    react: (emoji) => transport('react', { emoji: String(emoji) }),
    /** Delete the whole job folder. Safe to call more than once. */
    cleanupJob() {
      removeQuietly(jobDir, log);
    },
    sentFiles: () => [...sentFiles],
  };
}

module.exports = { createSender, assertJobDir, isProtected };
