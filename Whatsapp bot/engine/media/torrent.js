import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import cache from '../core/cache.js';
import { metrics } from '../core/metrics.js';
import { emit, EVENTS } from '../core/events.js';
import { episodeFileLabel } from '../core/tv.js';

const MB = 1024 * 1024;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|webm|mov|ts)$/i;
const MIN_VIDEO_BYTES = 30 * MB;

let client = null;
let webTorrentPromise = null;

function loadWebTorrent() {
  if (!webTorrentPromise) {
    webTorrentPromise = import('webtorrent')
      .then(({ default: WebTorrent }) => WebTorrent)
      .catch((error) => {
        const message = error?.message || String(error);
        throw Object.assign(
          new Error(`torrent engine unavailable: ${message} (check the optional WebTorrent install and npm logs, then restart)`),
          { code: 'NO_TORRENT_ENGINE' }
        );
      });
  }
  return webTorrentPromise;
}

async function getClient() {
  const WebTorrent = await loadWebTorrent();
  if (!client) client = new WebTorrent({ maxConns: 60, dht: true });
  return client;
}

export async function torrentEngineAvailable() {
  try {
    await loadWebTorrent();
    return true;
  } catch {
    return false;
  }
}

function isEligible(file) {
  return VIDEO_EXT.test(file?.name || '') &&
    !/(sample|trailer)/i.test(file.name) &&
    Number(file.length) >= MIN_VIDEO_BYTES;
}

const episodeLabel = (file) => episodeFileLabel(file?.name);

export function pickTorrentFile(files, { fileIdx, season, episode } = {}) {
  if (!Array.isArray(files) || !files.length) return null;
  const eligible = files.filter(isEligible);
  const index = Number(fileIdx);
  const indexed = fileIdx !== undefined && fileIdx !== null && Number.isInteger(index) && index >= 0 && index < files.length
    && isEligible(files[index]) ? files[index] : null;
  const targetSeason = Number(season);
  const targetEpisode = Number(episode);
  const isEpisode = season != null && episode != null && Number.isInteger(targetSeason) && Number.isInteger(targetEpisode);
  if (!isEpisode) return indexed || eligible.sort((a, b) => Number(b.length) - Number(a.length))[0] || null;

  const matches = (file) => {
    const label = episodeLabel(file);
    return label && label.season === targetSeason && targetEpisode >= label.first && targetEpisode <= label.last;
  };
  // A provider-specified file index is useful even for an unlabelled file, but
  // never trust it when its filename explicitly identifies a different episode.
  if (indexed && (!episodeLabel(indexed) || matches(indexed))) return indexed;
  const matching = eligible.filter(matches).sort((a, b) => Number(b.length) - Number(a.length));
  if (matching.length) return matching[0];
  // An unlabelled single-file torrent can still be an episode. A pack with no
  // clear match is ambiguous, so fail instead of sending the largest wrong file.
  if (eligible.length === 1 && !episodeLabel(eligible[0])) return eligible[0];
  return null;
}

function destroyTorrent(torrent) {
  if (!torrent || torrent.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    try {
      torrent.destroy({ destroyStore: false }, resolve);
    } catch {
      try { torrent.destroy(resolve); } catch { resolve(); }
    }
  });
}

export async function torrentToFile(magnet, dest, {
  onProgress,
  fileIdx,
  season,
  episode,
  maxMB = config.maxDownloadMB,
  metadataTimeoutMs = config.torrentMetadataTimeoutMs,
  stallTimeoutMs = config.torrentStallTimeoutMs
} = {}) {
  const partsDir = `${dest}.parts`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.mkdirSync(partsDir, { recursive: true });
  cache.markActive(partsDir);
  let torrent = null;
  let completed = false;

  try {
    emit(EVENTS.DOWNLOAD_START, { dest });
    torrent = (await getClient()).add(magnet, { path: partsDir });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no peers / metadata timeout')), metadataTimeoutMs);
      timeout.unref?.();
      torrent.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      torrent.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const files = torrent.files || [];
    const selected = pickTorrentFile(files, { fileIdx, season, episode });
    if (!selected) throw new Error(season != null && episode != null
      ? 'no matching episode file found in torrent'
      : 'no video file in torrent');
    const sizeMB = Number(selected.length) / MB;
    if (sizeMB > maxMB) throw new Error(`torrent file too big (${sizeMB.toFixed(0)}MB, cap ${maxMB}MB)`);

    for (const file of files) file.deselect();
    selected.select();

    let lastBytes = Number(selected.downloaded) || 0;
    let lastDataAt = Date.now();
    let lastReportAt = 0;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearInterval(watch);
        selected.removeListener('done', onDone);
        torrent.removeListener('error', onError);
        error ? reject(error) : resolve();
      };
      const onDone = () => finish();
      const onError = error => finish(error);
      const watch = setInterval(() => {
        const got = Number(selected.downloaded) || 0;
        if (got > lastBytes) {
          lastBytes = got;
          lastDataAt = Date.now();
        }
        if (got > lastReportAt) {
          lastReportAt = got;
          try { onProgress?.(got, Number(selected.length) || 0); } catch { /* progress is best effort */ }
          emit(EVENTS.DOWNLOAD_PROGRESS, { dest, got, total: Number(selected.length) || 0 });
        }
        if (Date.now() - lastDataAt > stallTimeoutMs) {
          finish(new Error(`torrent download stalled (no data for ${stallTimeoutMs}ms)`));
        }
      }, 1000);
      watch.unref?.();
      selected.once('done', onDone);
      torrent.once('error', onError);
      if (Number(selected.downloaded) >= Number(selected.length)) finish();
    });

    await destroyTorrent(torrent);
    const source = path.join(partsDir, selected.path);
    if (!fs.existsSync(source)) throw new Error('torrent completed without a file on disk');
    const extension = path.extname(selected.name) || '.mkv';
    const destination = path.extname(dest)
      ? `${dest.slice(0, -path.extname(dest).length)}${extension}`
      : `${dest}${extension}`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    completed = true;
    metrics.bump('download.bytes', {}, Number(selected.length) || 0);
    emit(EVENTS.DOWNLOAD_DONE, { dest: destination, bytes: Number(selected.length) || 0 });
    return { file: destination };
  } finally {
    try {
      if (!completed) await destroyTorrent(torrent);
    } finally {
      try {
        fs.rmSync(partsDir, { recursive: true, force: true });
      } finally {
        cache.unmarkActive(partsDir);
      }
    }
  }
}
