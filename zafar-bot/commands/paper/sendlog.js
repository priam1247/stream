'use strict';

/**
 * commands/paper/sendlog.js — the "already sent to this chat recently" record.
 *
 * The old bot kept this inside the shared database.js (paper_log.json).
 * Paper owns it now: storage/commands/paper/paper_log.json.
 */

const fs = require('fs');
const path = require('path');
const { writeRawAtomic, readJsonSafe } = require('./jsonstore');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'paper_log.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function read() {
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
  const log = read();
  if (!log[chatId]) log[chatId] = {};
  log[chatId][fileId] = Date.now();
  writeRawAtomic(FILE, JSON.stringify(prune(log), null, 2));
  return true;
}

function wasPaperSentRecently(chatId, fileId, days = 3) {
  const log = read();
  const at = log?.[chatId]?.[fileId];
  if (!at) return false;
  return Date.now() - at < days * 24 * 60 * 60 * 1000;
}

module.exports = { logPaperSent, wasPaperSentRecently, FILE, DATA_DIR };
