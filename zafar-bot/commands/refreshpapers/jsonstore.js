'use strict';

/**
 * commands/paper/jsonstore.js — atomic write + last-good read, own copy.
 * The vault snapshot must never be truncated by a panel kill mid-write.
 */

const fs = require('fs');
const path = require('path');

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

module.exports = { writeRawAtomic, readJsonSafe };
