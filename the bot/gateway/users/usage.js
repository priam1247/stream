'use strict';

// Counts only canonical command names, never message content, titles or chats.
// Each series is bound to an ownership claim AND a session generation.
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('../../lib/jsonStore');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'database', 'member-usage.json');
const DAY_MS = 86_400_000;
const MAX_DAYS = 14;
const MAX_SESSIONS = 101;
const MAX_COMMANDS = 64;
const COMMAND = /^[a-z0-9_-]{1,32}$/;
const SESSION = /^[a-f0-9]{24}$/;
const CLAIM = /^[a-f0-9]{64}$/;
let storeFile = DEFAULT_FILE;
let loaded = false;
let timer = null;
let startedAt = 0;
let sessions = [];

function utcDay(time) { return new Date(time).toISOString().slice(0, 10); }
function validScope(scope) {
  return scope && /^\d{7,15}$/.test(scope.number || '') && SESSION.test(scope.sessionId || '') && CLAIM.test(scope.claimToken || '');
}
function cleanDays(days, now) {
  if (!Array.isArray(days)) return [];
  const today = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const result = new Map();
  for (const day of days.slice(0, MAX_DAYS)) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    const time = Date.parse(`${day.date}T00:00:00.000Z`);
    if (!Number.isFinite(time) || utcDay(time) !== day.date || time > today || time < today - (MAX_DAYS - 1) * DAY_MS || !day.commands || typeof day.commands !== 'object' || Array.isArray(day.commands)) continue;
    const commands = Object.create(null);
    for (const [name, count] of Object.entries(day.commands).slice(0, MAX_COMMANDS)) {
      if (COMMAND.test(name) && Number.isSafeInteger(count) && count > 0 && count <= 1_000_000) commands[name] = count;
    }
    result.set(day.date, { date: day.date, commands });
  }
  return [...result.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function prune(now = Date.now()) {
  const unique = new Map();
  for (const entry of sessions.slice(0, MAX_SESSIONS * 2)) {
    if (!validScope(entry)) continue;
    const days = cleanDays(entry.days, now);
    if (!days.length) continue;
    const lastAt = Number.isSafeInteger(entry.lastAt) && entry.lastAt > 0 && entry.lastAt <= now + 60_000 ? Math.min(entry.lastAt, now) : 0;
    const lastCommand = typeof entry.lastCommand === 'string' && COMMAND.test(entry.lastCommand) ? entry.lastCommand : '';
    unique.set(`${entry.number}:${entry.sessionId}:${entry.claimToken}`, {
      number: entry.number, sessionId: entry.sessionId, claimToken: entry.claimToken, days,
      ...(lastAt && lastCommand ? { lastAt, lastCommand } : {}),
    });
  }
  sessions = [...unique.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, MAX_SESSIONS);
}
function scheduleFlush() {
  if (!storeFile || timer) return;
  timer = setTimeout(flushNow, 1500);
  timer.unref?.();
}
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const now = Date.now();
  const data = storeFile ? readJsonSafe(storeFile).data : null;
  startedAt = data && Number.isSafeInteger(data.startedAt) && data.startedAt > 0 && data.startedAt <= now ? data.startedAt : now;
  sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  prune(now);
  // Persist the coverage start even before the first command.
  if (!data?.startedAt) scheduleFlush();
}
function flushNow() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!storeFile) return;
  try { writeJsonAtomic(storeFile, { startedAt, sessions }); } catch { /* analytics must not block commands */ }
}
function recordCommand(name, scope) {
  const command = String(name || '').toLowerCase();
  if (!COMMAND.test(command) || !validScope(scope)) return;
  ensureLoaded();
  const now = Date.now();
  prune(now);
  let entry = sessions.find((item) => item.number === scope.number && item.sessionId === scope.sessionId && item.claimToken === scope.claimToken);
  if (!entry) {
    entry = { number: scope.number, sessionId: scope.sessionId, claimToken: scope.claimToken, days: [] };
    sessions.unshift(entry);
  }
  const date = utcDay(now);
  let day = entry.days.find((item) => item.date === date);
  if (!day) { day = { date, commands: Object.create(null) }; entry.days.push(day); }
  const key = Object.hasOwn(day.commands, command) || Object.keys(day.commands).length < MAX_COMMANDS - 1 ? command : 'other';
  day.commands[key] = Math.min(1_000_000, (day.commands[key] || 0) + 1);
  entry.lastAt = now;
  entry.lastCommand = command;
  prune(now);
  scheduleFlush();
}
/** Send only claims present in the latest local portal snapshot. */
function snapshot(users = []) {
  ensureLoaded();
  prune();
  const claims = new Map((Array.isArray(users) ? users : []).map((user) => [String(user.number || ''), String(user.backupClaim || '')]));
  return {
    startedAt,
    sessions: sessions.filter((entry) => claims.get(entry.number) === entry.claimToken)
      .map((entry) => ({ ...entry, days: entry.days.map((day) => ({ date: day.date, commands: { ...day.commands } })) })),
  };
}
function _resetForTests(file = null) {
  if (timer) clearTimeout(timer);
  timer = null;
  storeFile = file;
  loaded = false;
  startedAt = 0;
  sessions = [];
}
module.exports = { recordCommand, snapshot, flushNow, _resetForTests };
