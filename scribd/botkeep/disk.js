'use strict';
/**
 * Disk helpers for the capture server.
 *
 * Chromium is a ~210 MB binary plus its shared libraries, so the unpack needs
 * real room. These containers report their quota through statfs, so this module
 * answers three questions cheaply: how much is free, is a binary complete, and
 * how do we clean up what earlier runs left behind.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Chromium plus libs needs roughly this much; check before unpacking. */
const CHROMIUM_NEEDS_BYTES = 350 * 1024 * 1024;
/** A complete @sparticuz/chromium binary is far larger than this. */
const CHROMIUM_MIN_BYTES = 120 * 1024 * 1024;

function human(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/**
 * Free bytes for the filesystem holding `dir`.
 * Returns null when the platform cannot tell us (never invent a number).
 */
function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    const bavail = Number(stats.bavail);
    const bsize = Number(stats.bsize);
    if (Number.isFinite(bavail) && Number.isFinite(bsize)) return bavail * bsize;
  } catch {
    /* fall through */
  }
  return null;
}

/** A directory we can actually write to. */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where to unpack Chromium and scratch page images.
 *
 * Prefers SCRIBD_TEMP_DIR, then the platform temp dir, then a folder beside the
 * app. The chosen directory is normalised into TMPDIR/TMP/TEMP so puppeteer's
 * own scratch lands there too.
 */
function tempRoot() {
  const candidates = [
    (process.env.SCRIBD_TEMP_DIR || '').trim(),
    os.tmpdir(),
    path.join(__dirname, 'tmp'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (writable(candidate)) return candidate;
  }
  return path.join(__dirname, 'tmp');
}

function adoptTempRoot() {
  const root = tempRoot();
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return root;
}

/** Total size of a directory, without following surprises. */
function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(target) : fs.statSync(target).size;
    } catch {
      /* vanished mid-scan */
    }
  }
  return total;
}

/**
 * A usable Chromium binary.
 *
 * @sparticuz/chromium returns its path as soon as the file exists, so a run
 * that died part-way through unpacking leaves a truncated binary that it would
 * happily hand back. Anything clearly too small is removed.
 */
function isCompleteBinary(file) {
  if (!file) return false;
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile()) return false;
    if (stats.size < CHROMIUM_MIN_BYTES) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Delete a truncated binary so the next attempt unpacks a fresh one. */
function discardPartialBinary(file) {
  try {
    if (fs.existsSync(file) && !isCompleteBinary(file)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Remove scratch left by earlier runs: capture folders and part-written PDFs.
 * Only touches things this app created.
 */
function cleanStaleScratch(root, maxAgeMs = 60 * 60 * 1000) {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('scribd-')) continue;
    const target = path.join(root, name);
    try {
      const stats = fs.statSync(target);
      if (now - stats.mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

module.exports = {
  CHROMIUM_NEEDS_BYTES,
  CHROMIUM_MIN_BYTES,
  human,
  freeBytes,
  writable,
  tempRoot,
  adoptTempRoot,
  dirSize,
  isCompleteBinary,
  discardPartialBinary,
  cleanStaleScratch,
};
