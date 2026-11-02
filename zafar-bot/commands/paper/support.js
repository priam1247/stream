'use strict';

/**
 * commands/paper/support.js — the small helpers this command needs.
 *
 * Five former files are folded in here to respect the project's file-count
 * ceiling: config, redact, jsonstore, tmp and sendlog. Their bodies are
 * unchanged; the export names are exactly what the ported vault.js already uses,
 * so this is a file-count change, not a behaviour change.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ── config — Drime settings, read from the environment only ───────────────── */

const drime = {
  apiToken: process.env.DRIME_API_TOKEN || '',
  baseUrl: process.env.DRIME_BASE_URL || 'https://app.drime.cloud/api/v1',
  papersFolderId: Number(process.env.DRIME_PAPERS_FOLDER_ID || 841342462),
  papersFolderHash: process.env.DRIME_PAPERS_FOLDER_HASH || 'ODQxMzQyNDYyfA',
  workspaceId: Number(process.env.DRIME_WORKSPACE_ID || 0),
};

/* ── redact — strip credentials out of a provider error body ───────────────── */

function redactSecrets(input) {
  let s = String(input ?? '');
  s = s.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+|/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b\d+\|[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/([?&](?:api_?key|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  return s;
}

/* ── jsonstore — atomic write + last-good read ─────────────────────────────── */
// The vault snapshot must never be truncated by a panel kill mid-write.

function writeRawAtomic(targetPath, payload) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* gone */ } }
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

function readJsonSafe(targetPath, { defaultValue = null, validate = null } = {}) {
  const attempt = (file) => {
    if (!fs.existsSync(file)) return { ok: false, exists: false };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { ok: false, exists: true };
    const data = JSON.parse(raw);
    if (validate && !validate(data)) throw new Error('schema validation failed');
    return { ok: true, data };
  };
  try {
    const primary = attempt(targetPath);
    if (primary.ok) return { ...primary, corrupt: false };
  } catch { /* try the backup */ }
  try {
    const backup = attempt(`${targetPath}.bak`);
    if (backup.ok) return { ...backup, corrupt: false, fromBackup: true };
  } catch { /* both unreadable */ }
  const exists = fs.existsSync(targetPath) || fs.existsSync(`${targetPath}.bak`);
  return { ok: false, exists, corrupt: exists, data: defaultValue };
}

/* ── tmp — temp files for this command only ────────────────────────────────── */
// No global sweeper any more: every file lives in the job folder the gateway
// deletes, so holdTemp() is a no-op kept so the ported vault keeps its shape.

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
  try { fs.unlinkSync(file); } catch (err) {
    // Cleanup of a file that is already gone is expected; anything else is worth
    // seeing, so it is logged rather than swallowed.
    if (err.code !== 'ENOENT') console.warn(`[paper] could not delete temp file ${file}: ${err.message}`);
  }
}

/** No-op: nothing holds files across requests any more. */
function holdTemp() {
  return () => {};
}

/* ── sendlog — the "already sent to this chat recently" record ─────────────── */

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'paper_log.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readLog() {
  const res = readJsonSafe(FILE, { defaultValue: {}, validate: (d) => Boolean(d && typeof d === 'object') });
  return res.ok ? res.data : {};
}

function prune(log) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const chat of Object.keys(log)) {
    for (const id of Object.keys(log[chat])) {
      if (log[chat][id] < cutoff) delete log[chat][id];
    }
    if (!Object.keys(log[chat]).length) delete log[chat];
  }
  return log;
}

function logPaperSent(chatId, fileId) {
  const log = readLog();
  if (!log[chatId]) log[chatId] = {};
  log[chatId][fileId] = Date.now();
  writeRawAtomic(FILE, JSON.stringify(prune(log), null, 2));
  return true;
}

function wasPaperSentRecently(chatId, fileId, days = 3) {
  const log = readLog();
  const at = log?.[chatId]?.[fileId];
  if (!at) return false;
  return Date.now() - at < days * 24 * 60 * 60 * 1000;
}

module.exports = {
  drime,
  redactSecrets,
  writeRawAtomic,
  readJsonSafe,
  getTempDir,
  createTempFilePath,
  deleteTempFile,
  holdTemp,
  logPaperSent,
  wasPaperSentRecently,
  FILE,
  DATA_DIR,
};
