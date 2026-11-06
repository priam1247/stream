/**
 * ZaFar Bot — Database
 *
 * Read-through in-memory cache with atomic writes (temp file + rename) and
 * `.bak` last-good recovery via utils/jsonStore.js.
 * Getters return LIVE references — do not mutate them directly, always go
 * through the update* functions.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore');

const DB_PATH = path.join(__dirname, '..', 'database');
const BOT_STATE_DB = path.join(DB_PATH, 'botstate.json');
const PAPER_LOG_DB = path.join(DB_PATH, 'paper_log.json');

if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));

const initDB = (filePath, defaultData = {}) => {
  if (!fs.existsSync(filePath) && !fs.existsSync(`${filePath}.bak`)) {
    writeJsonAtomic(filePath, defaultData);
  }
};

initDB(BOT_STATE_DB, { on: true });
initDB(PAPER_LOG_DB, {});

// ─── Core (cached) ────────────────────────────────────────────────────────────

const _defaults = new Map([
  [BOT_STATE_DB, { on: true }],
  [PAPER_LOG_DB, {}],
]);

const _cache = {};
const _lastGood = {};

const readDB = (filePath) => {
  if (!_cache[filePath]) {
    const def = _defaults.get(filePath) || {};
    const res = readJsonSafe(filePath, {
      defaultValue: def,
      validate: isPlainObject,
    });
    if (res.ok) {
      _cache[filePath] = res.data;
      _lastGood[filePath] = JSON.parse(JSON.stringify(res.data));
    } else if (_lastGood[filePath]) {
      console.error(`[DB] Corrupt ${path.basename(filePath)} — keeping in-memory last-good state`);
      _cache[filePath] = JSON.parse(JSON.stringify(_lastGood[filePath]));
    } else {
      console.error(`[DB] Read error (${path.basename(filePath)}): ${res.error?.message || 'corrupt JSON'}`);
      _cache[filePath] = JSON.parse(JSON.stringify(def));
    }
  }
  return _cache[filePath];
};

const writeDB = (filePath, data) => {
  _cache[filePath] = data; // update cache first so readers never see stale data
  _lastGood[filePath] = JSON.parse(JSON.stringify(data));
  try {
    writeJsonAtomic(filePath, data);
    return true;
  } catch (error) {
    console.error(`[DB] Write error (${path.basename(filePath)}): ${error.message}`);
    return false;
  }
};

// ─── Bot State ────────────────────────────────────────────────────────────────

const getBotState = () => {
  const data = readDB(BOT_STATE_DB);
  return data.on !== false;
};

const setBotState = (state) => writeDB(BOT_STATE_DB, { on: Boolean(state) });

// ─── Paper Log ──────────────────────────────────────────────────────────────
// Remembers which papers were sent where, so the same paper is not sent again
// to the same chat within PAPER_DEDUPE_DAYS (default 5).
//   { "<chat key>": { "<file id>": <sent at ms> } }
// The chat key is the group JID for groups (so every linked account in that
// group shares ONE memory) and `<session>|<jid>` for private chats.
// Entries older than the window can never matter, so they are pruned (at most
// every 10 minutes), which keeps the file small. Papers are recorded in bulk,
// one write per batch.

const DAY_MS = 24 * 60 * 60 * 1000;
const PAPER_DEDUPE_DAYS = Math.max(1, Math.min(30, Number(process.env.PAPER_DEDUPE_DAYS) || 5));
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let _lastPrune = 0;

const _pruneOldPapers = (log, now) => {
  const cutoff = now - PAPER_DEDUPE_DAYS * DAY_MS;
  for (const chatId of Object.keys(log)) {
    for (const fileId of Object.keys(log[chatId])) {
      if (log[chatId][fileId] < cutoff) delete log[chatId][fileId];
    }
    if (Object.keys(log[chatId]).length === 0) delete log[chatId];
  }
};

/** Key under which a chat's paper history is kept. */
const paperChatKey = (chatId, sessionId = 'primary') => (
  String(chatId || '').endsWith('@g.us') || !sessionId || sessionId === 'primary'
    ? chatId
    : `${sessionId}|${chatId}`
);

const logPapersSent = (chatId, fileIds, now = Date.now()) => {
  const ids = [].concat(fileIds || []).filter((id) => id !== undefined && id !== null);
  if (!ids.length) return true;
  const log = readDB(PAPER_LOG_DB);
  if (!log[chatId]) log[chatId] = {};
  for (const id of ids) log[chatId][id] = now;
  if (now - _lastPrune >= PRUNE_EVERY_MS) { _lastPrune = now; _pruneOldPapers(log, now); }
  return writeDB(PAPER_LOG_DB, log);
};

const logPaperSent = (chatId, fileId) => logPapersSent(chatId, [fileId]);

/** When this paper was last sent to this chat, if that was within the window. */
const paperSentAt = (chatId, fileId, days = PAPER_DEDUPE_DAYS, now = Date.now()) => {
  try {
    const at = readDB(PAPER_LOG_DB)[chatId]?.[fileId];
    return at && now - at < days * DAY_MS ? at : null;
  } catch (_) {
    return null;
  }
};

const wasPaperSentRecently = (chatId, fileId, days = PAPER_DEDUPE_DAYS) => paperSentAt(chatId, fileId, days) !== null;

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getBotState,
  setBotState,
  logPaperSent,
  logPapersSent,
  paperSentAt,
  paperChatKey,
  wasPaperSentRecently,
  PAPER_DEDUPE_DAYS,
};
