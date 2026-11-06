/**
 * Global Cleanup System
 *
 * Keeps ./temp from growing forever. Three independent brakes:
 *
 *   1. boot  — remove recognizable leftovers of interrupted bot jobs.
 *   2. age   — remove old, unheld bot job files.
 *   3. size  — if ./temp exceeds TEMP_MAX_MB, remove oldest unheld job files.
 *
 * Unknown/user files, session data and databases are never swept.
 */

const fs = require('fs');
const path = require('path');
const { getTempDir, isHeld } = require('./tempManager');
const config = require('../config');
const log = require('./logger')('cleanup');

// Cleanup interval: 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Age thresholds
const SCRAP_AGE_MS = 30 * 60 * 1000;        // download scraps, part files
const MEDIA_AGE_MS = 60 * 60 * 1000;        // ytv_/song_/movie files
const OTHER_AGE_MS = 6 * 60 * 60 * 1000;
const PARTIAL_NAME = /(\.(part|ytdl|tmp|f\d+\.[a-z0-9]+)$|\.(part|ytdl)-Frag)/i;
// A timestamp/random job stamp distinguishes generated files from user data.
const STAMPED_JOB = /^(?:ytv|song|aud|dl|fb|paper|conv|audio|video|url|mp3|it|sticker|movie_sub|series_sub)_\d{10,}_[a-z0-9]+(?:[._-]|$)/i;
const MOVIE_JOB = /^movie_.+\.[a-f0-9]{16}\./i;
const HLS_JOB = /^\.nm3u8_\d{10,}_[a-z0-9]+$/i;

function managedPath(file) {
  return String(file || '').split(/[\\/]+/).some((part) => STAMPED_JOB.test(part) || MOVIE_JOB.test(part) || HLS_JOB.test(part));
}

// yt-dlp/ffmpeg can stamp a fresh file with the source's old Last-Modified
// time; ctime is set when the file is written here, so take the newer one.
const ageOf = (stats, now = Date.now()) => now - Math.max(stats.mtimeMs, stats.ctimeMs);

// Size cap for the whole temp tree (sensible default: 2048 MB for a 10 GB plan)
const configuredTempMaxMB = () => {
  const raw = process.env.TEMP_MAX_MB ?? config.disk?.tempMaxMB ?? 2048;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2048;
};

// Session directory name (must NOT be cleaned)
const SESSION_DIR_NAME = config.sessionName || 'session';

// Engine bookkeeping that must survive a regular age/size sweep
const KEEP_NAMES = /^(cache\.json(\.bak)?|imdb-index\.tsv)$/i;

let cleanupInterval = null;

const thresholdFor = (name) => {
  if (PARTIAL_NAME.test(name)) return SCRAP_AGE_MS;
  if (managedPath(name)) return MEDIA_AGE_MS;
  return OTHER_AGE_MS;
};

/** Every regular file under `dir`, with its raw size/mtime/ctime. */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === SESSION_DIR_NAME || e.name === 'database') continue;
      walk(p, out);
      continue;
    }
    try {
      const st = fs.statSync(p);
      out.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
    } catch { /* raced with a delete */ }
  }
  return out;
}

/** Total bytes in the temp tree (used by the boot log and `.moviestatus`). */
function tempUsage(dir = null) {
  const files = walk(dir || getTempDir());
  return files.reduce((n, f) => n + f.size, 0);
}

function unlink(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

function pruneEmpty(dir) {
  if (isHeld(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name));
    }
    fs.rmdirSync(dir); // never recursively delete unknown contents
  } catch { /* not empty, in use, or already gone */ }
}

/**
 * Boot-time sweep: nothing is downloading yet, and delivered files are never
 * cached, so any leftover `.part`/`.ytdl`/`.tmp`, media job file, or stranded
 * movie file inside `temp/` from an interrupted run can be deleted immediately.
 */
function sweepBootPartials(dir = null) {
  const result = { files: 0, freedBytes: 0 };
  try {
    const tempDir = dir || getTempDir();
    if (!fs.existsSync(tempDir)) return result;

    const moviesSubdir = path.resolve(tempDir, 'movies');
    const all = walk(tempDir).filter((f) => !KEEP_NAMES.test(f.name) && managedPath(f.path) && !isHeld(f.path));

    for (const f of all) {
      if (unlink(f.path)) {
        result.files++;
        result.freedBytes += f.size;
      }
    }

    // Remove empty `.nm3u8_*` staging folders left behind by interrupted jobs
    for (const parent of [tempDir, moviesSubdir]) {
      let entries = [];
      try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || !(HLS_JOB.test(e.name) || (MOVIE_JOB.test(e.name) && e.name.endsWith('.parts')))) continue;
        const full = path.join(parent, e.name);
        pruneEmpty(full);
      }
    }

    if (result.files > 0) {
      log.debug(
        `Boot sweep: removed ${result.files} leftover partial/staging file(s) ` +
        `(${(result.freedBytes / 1048576).toFixed(1)} MB freed)`
      );
    }
  } catch (error) {
    console.error('Error during boot partial sweep:', error.message);
  }
  return result;
}

/**
 * Delete old files, then enforce the size cap.
 * @returns {{files:number, freedBytes:number, remainingBytes:number}}
 */
function cleanupOldFiles(dir = null, opts = {}) {
  const result = { files: 0, freedBytes: 0, remainingBytes: 0 };
  try {
    const tempDir = dir || getTempDir();
    if (!fs.existsSync(tempDir)) return result;

    // `now` is injectable so tests can age a whole tree without touching clocks
    const now = Number(opts.now) || Date.now();
    const maxMB = opts.maxMB !== undefined ? Number(opts.maxMB) : configuredTempMaxMB();
    // Include unowned/held bytes in the size report but never delete them.
    const all = walk(tempDir);
    const candidates = all.filter((f) => !KEEP_NAMES.test(f.name) && managedPath(f.path) && !isHeld(f.path));
    let total = all.reduce((n, f) => n + f.size, 0);

    // ── 1. age ────────────────────────────────────────────────────────────
    const survivors = [];
    for (const f of candidates) {
      if (ageOf({ mtimeMs: f.mtime, ctimeMs: f.ctime }, now) > thresholdFor(f.name)) {
        if (unlink(f.path)) { total -= f.size; result.files++; result.freedBytes += f.size; }
        else survivors.push(f);
      } else {
        survivors.push(f);
      }
    }

    // ── 2. size cap ───────────────────────────────────────────────────────
    if (maxMB > 0 && total > maxMB * 1024 * 1024) {
      survivors.sort((a, b) => a.mtime - b.mtime);       // oldest first
      for (const f of survivors) {
        if (total <= maxMB * 1024 * 1024) break;
        if (unlink(f.path)) { total -= f.size; result.files++; result.freedBytes += f.size; }
      }
    }

    result.remainingBytes = Math.max(0, total);

    if (result.files > 0) {
      const freedMB = (result.freedBytes / 1048576).toFixed(1);
      const leftMB = (result.remainingBytes / 1048576).toFixed(1);
      log.debug(`Cleanup: removed ${result.files} file(s), freed ${freedMB} MB — temp now ${leftMB} MB`);
    }
  } catch (error) {
    console.error('Error during cleanup:', error.message);
  }
  return result;
}

/**
 * Start the cleanup system:
 *   1. Sweep leftover partial/interrupted files from previous boot,
 *   2. Run age + size cap cleanup,
 *   3. Schedule periodic sweeps every CLEANUP_INTERVAL_MS.
 */
function startCleanup() {
  log.debug('Starting temp cleanup');
  sweepBootPartials();
  const first = cleanupOldFiles();
  const capMB = configuredTempMaxMB();
  log.debug(
    `temp ${(first.remainingBytes / 1048576).toFixed(1)} MB after cleanup` +
    `${capMB ? ` (cap ${capMB} MB)` : ''}`
  );

  if (cleanupInterval) clearInterval(cleanupInterval);
  cleanupInterval = setInterval(() => { cleanupOldFiles(); }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref?.();

  log.debug(`Cleanup interval ${CLEANUP_INTERVAL_MS / 1000 / 60} minutes`);
}

/** Stop the cleanup system */
function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.debug('Cleanup stopped');
  }
}

// The application entry point owns signal handling so session writes and
// encrypted recovery can finish before the process exits.
module.exports = {
  thresholdFor,
  ageOf,
  sweepBootPartials,
  cleanupOldFiles,
  configuredTempMaxMB,
  startCleanup,
  stopCleanup,
  tempUsage,
};
