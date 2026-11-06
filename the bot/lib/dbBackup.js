'use strict';

/**
 * Rotating backups of the bot's small state files (database/*.json).
 *
 * What is saved: the approved-users list, bot on/off state, command on/off
 * state, member policy and usage, media settings, the paper history and the
 * counters. What is NOT saved: credentials and tokens (yt_auth.json, WhatsApp
 * sessions — those have their own encrypted backup), and rebuildable caches
 * (vault snapshot, movie cache).
 *
 * One snapshot = one small JSON file in database/backups/. A snapshot is only
 * written when something changed since the newest one, and only the newest
 * DB_BACKUP_KEEP (default 10) are kept.
 *
 * Automatic: after boot, every DB_BACKUP_EVERY_HOURS (default 6) and on stop.
 * Manual (stop the bot first so it does not overwrite what you restore):
 *   node lib/dbBackup.js list
 *   node lib/dbBackup.js restore [latest|<file name>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./jsonStore');

const DEFAULT_DIR = path.join(__dirname, '..', 'database');
const FILES = [
  'whitelist.json', 'botstate.json', 'disabled-commands.json', 'member-command-policy.json',
  'member-usage.json', 'media_settings.json', 'paper_log.json', 'telemetry.json',
];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_.-]+\.json$/;
const BUNDLE_NAME = /^db-\d{8}-\d{6}(?:-[a-z-]+)?\.json$/;

const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number(value) || fallback));

function createDbBackup({
  dir = DEFAULT_DIR,
  keep = clamp(process.env.DB_BACKUP_KEEP, 2, 50, 10),
  now = () => new Date(),
  log = console,
} = {}) {
  const backupDir = path.join(dir, 'backups');
  let timer = null;

  const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const bundles = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((n) => BUNDLE_NAME.test(n)).sort() : []);
  const readBundle = (name) => JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8'));

  /** Read every backed-up file; corrupt or oversized ones are reported, not saved. */
  function collect() {
    const files = {}; const skipped = [];
    for (const name of FILES) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) { skipped.push(`${name}: too large`); continue; }
        files[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        skipped.push(`${name}: ${String(error.message).slice(0, 80)}`);
      }
    }
    return { files, skipped };
  }

  const digestOf = (files) => crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');

  /** Write a snapshot unless nothing changed since the newest one. */
  function snapshot(reason = 'auto') {
    const { files, skipped } = collect();
    if (!Object.keys(files).length) return { changed: false, file: null, skipped };
    const digest = digestOf(files);
    const existing = bundles();
    if (existing.length) {
      try { if (readBundle(existing.at(-1)).digest === digest) return { changed: false, file: existing.at(-1), skipped }; } catch { /* unreadable newest: write a fresh one */ }
    }
    const suffix = reason === 'auto' ? '' : `-${String(reason).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '').slice(0, 12)}`;
    const name = `db-${stamp(now())}${suffix}.json`;
    fs.mkdirSync(backupDir, { recursive: true });
    // Write to a temp name and rename, so a crash never leaves a half-written
    // snapshot (and no `.bak` copies pile up next to the snapshots).
    const target = path.join(backupDir, name);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 1, createdAt: now().toISOString(), reason, digest, files, skipped }));
    fs.renameSync(`${target}.tmp`, target);
    for (const old of bundles().slice(0, -keep)) { try { fs.unlinkSync(path.join(backupDir, old)); } catch { /* rotation is best effort */ } }
    // Sweep leftovers of an interrupted write.
    for (const stray of fs.readdirSync(backupDir)) {
      if (/\.(tmp|bak)$/.test(stray)) { try { fs.unlinkSync(path.join(backupDir, stray)); } catch { /* best effort */ } }
    }
    if (skipped.length) log.warn?.(`[backup] skipped: ${skipped.join('; ')}`);
    return { changed: true, file: name, skipped };
  }

  /** Newest snapshot, for `.status`. */
  function latest() {
    const names = bundles();
    if (!names.length) return null;
    try { const b = readBundle(names.at(-1)); return { file: names.at(-1), createdAt: b.createdAt, count: names.length }; }
    catch { return { file: names.at(-1), createdAt: null, count: names.length }; }
  }

  /**
   * Put a snapshot's files back. The current state is snapshotted first
   * ("pre-restore"), and only the known state files can be written.
   */
  function restore(which = 'latest') {
    const names = bundles();
    const name = which === 'latest' ? names.at(-1) : which;
    if (!name || !BUNDLE_NAME.test(name) || !names.includes(name)) throw new Error('no such backup');
    const bundle = readBundle(name);
    if (bundle?.version !== 1 || !bundle.files || typeof bundle.files !== 'object') throw new Error('backup file is not valid');
    for (const key of Object.keys(bundle.files)) {
      if (!FILES.includes(key) || !SAFE_NAME.test(key)) throw new Error(`backup contains an unexpected file: ${key}`);
    }
    snapshot('pre-restore');
    const restored = [];
    for (const [key, data] of Object.entries(bundle.files)) {
      writeJsonAtomic(path.join(dir, key), data);
      restored.push(key);
    }
    return { file: name, restored };
  }

  /** First snapshot shortly after boot, then every few hours. */
  function start({ everyHours = clamp(process.env.DB_BACKUP_EVERY_HOURS, 1, 168, 6), firstDelayMs = 30_000 } = {}) {
    stop();
    const run = (reason) => { try { snapshot(reason); } catch (error) { log.warn?.(`[backup] failed: ${String(error.message).slice(0, 120)}`); } };
    const first = setTimeout(() => run('auto'), firstDelayMs);
    const every = setInterval(() => run('auto'), everyHours * 60 * 60 * 1000);
    first.unref?.(); every.unref?.();
    timer = { first, every };
  }
  function stop() { if (timer) { clearTimeout(timer.first); clearInterval(timer.every); timer = null; } }

  return { snapshot, latest, restore, start, stop, list: bundles, FILES, backupDir };
}

module.exports = { ...createDbBackup(), createDbBackup };

if (require.main === module) {
  const backup = module.exports;
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === 'list') {
      const names = backup.list();
      console.log(names.length ? names.join('\n') : 'no backups yet');
    } else if (command === 'restore') {
      const result = backup.restore(arg || 'latest');
      console.log(`Restored ${result.restored.join(', ')} from ${result.file}. Start the bot again.`);
    } else {
      console.log('Usage: node lib/dbBackup.js list | restore [latest|<file name>]   (stop the bot before restoring)');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}
