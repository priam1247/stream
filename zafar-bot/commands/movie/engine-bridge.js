'use strict';

/**
 * commands/movie/engine-bridge.js — CommonJS -> ESM bridge for THIS command's own
 * copy of the movie engine.
 *
 * Rule 2 in practice: .movie and .series each carry a complete engine under
 * engine/. Nothing is shared, so fixing .movie can never break .series.
 *
 * The engine reads its configuration at import time, so every value is pushed
 * into process.env BEFORE the first import(). Configuration comes from the
 * environment only — this file knows nothing about ctx or the gateway.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');          // bot root
const ENGINE = path.join(__dirname, 'engine');          // this command's copy

let enginePromise = null;
let loaded = null;

const setIfEmpty = (key, value) => {
  if (value === undefined || value === null || value === '') return;
  if (process.env[key] !== undefined) return;
  process.env[key] = String(value);
};

/** The job's temp folder, handed in by ctx via configure(). */
let jobTempDir = path.join(ROOT, 'storage', 'tmp', 'movie');

function configure({ tmp, maxSendMB, maxDownloadMB, quality } = {}) {
  if (tmp) jobTempDir = tmp;
  setIfEmpty('TEMP_DIR', jobTempDir);
  setIfEmpty('JOB_DIR', jobTempDir);
  setIfEmpty('CACHE_FILE', path.join(jobTempDir, 'cache.json'));
  setIfEmpty('DATA_DIR', path.join(jobTempDir, 'data'));
  setIfEmpty('CACHE_MAX_MB', 0);
  setIfEmpty('MAX_SEND_MB', maxSendMB);
  setIfEmpty('MAX_DOWNLOAD_MB', maxDownloadMB);
  setIfEmpty('MOVIE_QUALITY', quality);
  setIfEmpty('MIN_FREE_MB', 800);
  setIfEmpty('TORRENT_DIRECT', '1');
  setIfEmpty('MOVIE_QUIET', '1');
  // The engine shipped with a 1080 -> 720 -> 480 quality fallback chain. The
  // new architecture forbids fallback chains, so it is switched off here: if the
  // requested quality has no source, the command fails and says why.
  setIfEmpty('QUALITY_FALLBACK', '0');
}

/**
 * Load the engine (idempotent). A failure is rethrown with the cause attached;
 * it is never retried silently and never swapped for a different engine.
 */
function load() {
  if (!enginePromise) {
    const entry = pathToFileURL(path.join(ENGINE, 'media', 'index.js')).href;
    enginePromise = import(entry)
      .then((mod) => {
        loaded = mod;
        return mod;
      })
      .catch((err) => {
        enginePromise = null;
        const wrapped = new Error(`movie engine failed to load: ${err.message}`);
        wrapped.code = 'ENGINE_LOAD';
        wrapped.cause = err;
        throw wrapped;
      });
  }
  return enginePromise;
}

const isLoaded = () => Boolean(loaded);

module.exports = {
  configure,
  load,
  isLoaded,
  ROOT,
  ENGINE,
  setIfEmpty,
  get jobTempDir() { return jobTempDir; },

  async search(title, { type = 'movie', year = null, limit = 8 } = {}) {
    const { metadata } = await load();
    return metadata.search(title, { type, year, limit });
  },
  async details(item) {
    const { metadata } = await load();
    return metadata.details(item);
  },
  async lookup(title, opts = {}) {
    const { metadata } = await load();
    return metadata.lookup(title, opts);
  },
  async providers() {
    const { registry } = await load();
    return registry.list ? registry.list() : [];
  },
};
