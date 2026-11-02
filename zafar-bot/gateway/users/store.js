'use strict';

/**
 * gateway/users/store.js — the ONLY writer of users.json.
 *
 * Layout, per linked number:
 *   storage/core/numbers/<number>/users.json
 *   storage/core/numbers/<number>/settings.json
 *
 * Plus one global file, because the owner is the same person on every number:
 *   storage/core/owner.json   { "number": "265991234567" }
 *
 * Anything writing these files outside this module is a bug. Grep for
 * `users.json` in the codebase: it appears here and in scripts/add-owner.js
 * (which delegates to this module).
 */

const fs = require('fs');
const path = require('path');
const {
  paths, numberDir, usersFile, settingsFile,
} = require('../../lib/paths');
const { writeJsonAtomic, readJsonSafe, ensureDir, clone } = require('../../lib/fsutil');
const { usersLog } = require('../log');
const roles = require('./roles');
const jid = require('../../lib/jid');

const OWNER_FILE = path.join(paths.storageCore, 'owner.json');

const DEFAULT_SETTINGS = Object.freeze({
  accessMode: 'open',        // 'open' | 'whitelist'
  maintenance: false,
  prefix: null,              // null -> fall back to config.prefix
});

const isValidUsers = (data) => Boolean(data && typeof data === 'object' && Array.isArray(data.users));
const isValidSettings = (data) => Boolean(
  data && typeof data === 'object' &&
  ['open', 'whitelist'].includes(data.accessMode) &&
  typeof data.maintenance === 'boolean',
);

function readOwner() {
  const res = readJsonSafe(OWNER_FILE, { defaultValue: { number: '' }, validate: (d) => Boolean(d && typeof d === 'object') });
  const number = res.ok ? jid.digits(res.data?.number) : '';
  return jid.isNumber(number) ? number : '';
}

function writeOwner(number) {
  const digits = jid.digits(number);
  if (!jid.isNumber(digits)) throw new Error(`not a usable owner number: ${JSON.stringify(number)}`);
  ensureDir(paths.storageCore);
  writeJsonAtomic(OWNER_FILE, { number: digits, setAt: new Date().toISOString() });
  usersLog.info('owner set', { number: digits });
  return digits;
}

/* ── users ───────────────────────────────────────────────────────────────── */

function readUsers(number) {
  ensureDir(numberDir(number));
  const res = readJsonSafe(usersFile(number), {
    defaultValue: { users: [] },
    validate: isValidUsers,
  });
  if (res.corrupt) {
    // Never degrade to an empty list: that would silently delete every member
    // on the next write. Same rule the old accessControl.js enforced.
    throw new Error(
      `users.json for ${number} is corrupt and has no usable .bak — refusing to treat it as an empty list`,
    );
  }
  return res.ok ? res.data : { users: [] };
}

function writeUsers(number, data, reason, meta = {}) {
  if (!isValidUsers(data)) throw new Error('refusing to write invalid users payload');
  ensureDir(numberDir(number));
  writeJsonAtomic(usersFile(number), data);
  usersLog.info(reason, { number, ...meta });
  return data;
}

function blankRecord(number, { name = '', role = 'user' } = {}) {
  const now = new Date().toISOString();
  return {
    number: jid.digits(number),
    name: String(name || ''),
    role,
    status: role === 'banned' ? 'banned' : 'active',
    joinedAt: now,
    lastSeen: null,
    blockedCommands: [],
    usage: {},
  };
}

function findIndex(users, number) {
  const target = jid.digits(number);
  return users.findIndex((u) => jid.digits(u.number) === target);
}

/**
 * Effective role: the global owner wins on every number, regardless of what a
 * per-number record says. A per-number admin cannot demote or remove the owner.
 */
function effectiveRole(number, users) {
  const digits = jid.digits(number);
  if (!digits) return null;
  if (readOwner() && readOwner() === digits) return 'owner';
  const idx = findIndex(users, digits);
  if (idx === -1) return null;
  return users[idx].role || 'user';
}

function getUser(number, userId) {
  const data = readUsers(number);
  const idx = findIndex(data.users, userId);
  return idx === -1 ? null : clone(data.users[idx]);
}

function requireUser(number, userId) {
  const user = getUser(number, userId);
  if (!user) throw new Error(`no user ${jid.digits(userId)} on number ${number}`);
  return user;
}

function listUsers(number) {
  return clone(readUsers(number).users);
}

function upsert(number, userId, patch, reason) {
  const data = readUsers(number);
  const digits = jid.digits(userId);
  if (!jid.isNumber(digits)) throw new Error(`not a usable number: ${JSON.stringify(userId)}`);

  let idx = findIndex(data.users, digits);
  const isNew = idx === -1;
  if (isNew) {
    data.users.push(blankRecord(digits, patch));
    idx = data.users.length - 1;
  }
  const record = data.users[idx];
  const allowed = ['name', 'role', 'status', 'blockedCommands'];
  for (const key of allowed) {
    if (patch[key] !== undefined) record[key] = patch[key];
  }
  if (patch.role !== undefined) {
    if (!roles.isValidRole(patch.role)) throw new Error(`unknown role: ${JSON.stringify(patch.role)}`);
    record.role = patch.role;
    record.status = patch.role === 'banned' ? 'banned' : 'active';
  }
  writeUsers(number, data, reason || (isNew ? 'user added' : 'user updated'), { user: digits });
  return clone(record);
}

const addUser = (number, userId, opts = {}) => upsert(
  number, userId, { name: opts.name || '', role: opts.role || 'user' }, opts.reason || 'user added',
);

function removeUser(number, userId) {
  const data = readUsers(number);
  const digits = jid.digits(userId);
  if (readOwner() === digits) throw new Error('refusing to remove the owner');
  const before = data.users.length;
  data.users = data.users.filter((u) => jid.digits(u.number) !== digits);
  if (data.users.length === before) throw new Error(`no user ${digits} on number ${number}`);
  writeUsers(number, data, 'user removed', { user: digits });
  return true;
}

function setRole(number, userId, role) {
  if (!roles.isValidRole(role)) throw new Error(`unknown role: ${JSON.stringify(role)}`);
  const digits = jid.digits(userId);
  if (readOwner() === digits && role !== 'owner') {
    throw new Error('refusing to change the owner role on a per-number record');
  }
  return upsert(number, digits, { role }, `role -> ${role}`);
}

const banUser = (number, userId) => upsert(number, userId, { role: 'banned' }, 'user banned');
const unbanUser = (number, userId) => upsert(number, userId, { role: 'user' }, 'user unbanned');

function blockCommand(number, userId, command) {
  const data = readUsers(number);
  const idx = findIndex(data.users, userId);
  if (idx === -1) throw new Error(`no user ${jid.digits(userId)} on number ${number}`);
  const record = data.users[idx];
  const name = String(command || '').toLowerCase();
  if (!name) throw new Error('a command name is required');
  if (!record.blockedCommands.includes(name)) record.blockedCommands.push(name);
  writeUsers(number, data, 'command blocked', { user: jid.digits(userId), command: name });
  return clone(record);
}

function unblockCommand(number, userId, command) {
  const data = readUsers(number);
  const idx = findIndex(data.users, userId);
  if (idx === -1) throw new Error(`no user ${jid.digits(userId)} on number ${number}`);
  const name = String(command || '').toLowerCase();
  const record = data.users[idx];
  record.blockedCommands = record.blockedCommands.filter((c) => c !== name);
  writeUsers(number, data, 'command unblocked', { user: jid.digits(userId), command: name });
  return clone(record);
}

function touch(number, userId) {
  const data = readUsers(number);
  const idx = findIndex(data.users, userId);
  if (idx === -1) return false;
  data.users[idx].lastSeen = new Date().toISOString();
  // lastSeen is telemetry, not a permission change: no audit line, no backup churn.
  writeJsonAtomic(usersFile(number), data);
  return true;
}

function recordCommandUse(number, userId, command) {
  const data = readUsers(number);
  const idx = findIndex(data.users, userId);
  if (idx === -1) return false;
  const record = data.users[idx];
  record.usage = record.usage || {};
  record.usage[command] = (record.usage[command] || 0) + 1;
  record.lastSeen = new Date().toISOString();
  writeJsonAtomic(usersFile(number), data);
  return true;
}

/* ── settings ────────────────────────────────────────────────────────────── */

function readSettings(number) {
  ensureDir(numberDir(number));
  const res = readJsonSafe(settingsFile(number), {
    defaultValue: { ...DEFAULT_SETTINGS },
    validate: isValidSettings,
  });
  if (!res.ok) {
    // First boot for this number: materialise the defaults on disk.
    const fresh = { ...DEFAULT_SETTINGS };
    writeJsonAtomic(settingsFile(number), fresh);
    return fresh;
  }
  return { ...DEFAULT_SETTINGS, ...res.data };
}

function writeSettings(number, patch) {
  const next = { ...readSettings(number), ...patch };
  if (!isValidSettings(next)) throw new Error(`invalid settings for ${number}: ${JSON.stringify(next)}`);
  ensureDir(numberDir(number));
  writeJsonAtomic(settingsFile(number), next);
  usersLog.info('settings changed', { number, ...patch });
  return next;
}

const setAccessMode = (number, mode) => {
  if (!['open', 'whitelist'].includes(mode)) throw new Error(`unknown access mode: ${JSON.stringify(mode)}`);
  return writeSettings(number, { accessMode: mode });
};

const setMaintenance = (number, on) => writeSettings(number, { maintenance: Boolean(on) });

/* ── listing ─────────────────────────────────────────────────────────────── */

function listNumbers() {
  ensureDir(paths.numbers);
  return fs.readdirSync(paths.numbers)
    .filter((name) => /^\d{7,15}$/.test(name))
    .filter((name) => fs.existsSync(path.join(paths.numbers, name)))
    .sort();
}

/** Create the per-number files so a fresh session has somewhere to write. */
function ensureNumber(number) {
  readUsers(number);
  readSettings(number);
  return number;
}

module.exports = {
  OWNER_FILE,
  DEFAULT_SETTINGS,
  readOwner,
  writeOwner,
  readUsers,
  writeUsers,
  blankRecord,
  effectiveRole,
  getUser,
  requireUser,
  listUsers,
  addUser,
  removeUser,
  setRole,
  banUser,
  unbanUser,
  blockCommand,
  unblockCommand,
  touch,
  recordCommandUse,
  readSettings,
  writeSettings,
  setAccessMode,
  setMaintenance,
  listNumbers,
  ensureNumber,
  isValidUsers,
  isValidSettings,
};
