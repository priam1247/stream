'use strict';

/**
 * lib/fsutil.js — atomic JSON read/write.
 *
 * Ported from the old utils/jsonStore.js: temp file + fsync + rename, plus a
 * `.bak` last-good copy. The old bot needed this because a panel kill during a
 * write truncated whitelist.json and silently emptied the member list. Same
 * failure mode applies to users.json, so the mechanism comes across.
 */

const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function writeRawAtomic(targetPath, payload) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* temp never created */ }
    throw err;
  }
}

function writeJsonAtomic(targetPath, value) {
  writeRawAtomic(targetPath, JSON.stringify(value, null, 2));
  // Last-good copy. A failure here must not fail the write that succeeded.
  try {
    writeRawAtomic(`${targetPath}.bak`, JSON.stringify(value, null, 2));
  } catch {
    // .bak is durability, not correctness; the primary write is already durable.
  }
  return true;
}

/**
 * @returns {{ok:boolean, data:any, exists:boolean, corrupt:boolean, error?:Error}}
 */
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
  } catch {
    // fall through to the backup copy
  }

  try {
    const backup = attempt(`${targetPath}.bak`);
    if (backup.ok) return { ...backup, corrupt: false, fromBackup: true };
  } catch {
    // both copies unreadable
  }

  const exists = fs.existsSync(targetPath) || fs.existsSync(`${targetPath}.bak`);
  return { ok: false, exists, corrupt: exists, data: clone(defaultValue) };
}

function readJson(targetPath, fallback) {
  const res = readJsonSafe(targetPath, { defaultValue: fallback });
  return res.ok ? res.data : clone(fallback);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exists(p) {
  return fs.existsSync(p);
}

module.exports = { writeRawAtomic, writeJsonAtomic, readJsonSafe, readJson, ensureDir, exists, clone };
