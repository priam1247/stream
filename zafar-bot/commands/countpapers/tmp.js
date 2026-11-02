'use strict';

/**
 * commands/paper/tmp.js — temp files for this command only.
 *
 * The old tempManager held files in a shared pool with a "held" registry so a
 * global sweeper would not delete them. There is no global sweeper any more:
 * every file lives in the job folder the gateway deletes, so the registry is a
 * no-op kept only so the ported vault.js keeps its shape.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getTempDir() {
  if (process.env.ZAFAR_JOB_TMP) return process.env.ZAFAR_JOB_TMP;
  const dir = path.join(require('os').tmpdir(), 'zafar-paper');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createTempFilePath(ext = '.tmp') {
  const dir = getTempDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
}

function deleteTempFile(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** No-op: nothing holds files across requests any more. */
function holdTemp() {
  return () => {};
}

module.exports = { getTempDir, createTempFilePath, deleteTempFile, holdTemp };
