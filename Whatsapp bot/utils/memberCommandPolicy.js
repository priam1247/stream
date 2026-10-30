'use strict';

// The dashboard is authoritative. Persist the last confirmed policy so that
// a restart cannot silently turn maintenance switches back on.
const crypto = require('crypto');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./jsonStore');

const FILE = path.join(__dirname, '..', 'database', 'member-command-policy.json');
const valid = (data) => Boolean(data && /^[a-f0-9]{16}$/.test(data.version || '') &&
  Array.isArray(data.disabled) && data.disabled.every((name) => /^[a-z0-9_]{1,40}$/.test(name)) &&
  versionFor(data.disabled) === data.version);
function versionFor(disabled) {
  return crypto.createHash('sha256').update(JSON.stringify([...new Set(disabled)].sort())).digest('hex').slice(0, 16);
}
const initial = readJsonSafe(FILE, { defaultValue: null, validate: valid });
let policy = initial.ok && initial.exists ? initial.data : null;

function apply(disabled, version) {
  if (!Array.isArray(disabled) || disabled.length > 200) throw new Error('Invalid member command policy');
  const next = { disabled: [...new Set(disabled)].sort(), version: String(version || '') };
  if (!valid(next)) throw new Error('Invalid member command policy');
  writeJsonAtomic(FILE, next);
  policy = next;
  return policy.version;
}
function version() { return policy?.version || ''; }
function isUnavailable(name) {
  if (!policy) {
    // Without any portal policy, connected deployments fail closed for members;
    // a standalone deployment without dashboard sync retains its old behavior.
    return Boolean(process.env.DASHBOARD_URL && (process.env.BOT_SYNC_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN));
  }
  return policy.disabled.includes(String(name || '').toLowerCase());
}
module.exports = { apply, version, isUnavailable, versionFor };
