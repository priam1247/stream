// engine/media/downloader.js — thin wrapper choosing HLS vs HTTP download path.
import { httpToFile, hlsToFile } from './download.js';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cache from '../core/cache.js';
import { metrics } from '../core/metrics.js';
import { emit, EVENTS } from '../core/events.js';
import config from '../config.js';

const WORKER = fileURLToPath(new URL('./torrentWorker.js', import.meta.url));
const HOUR = 60 * 60 * 1000;

/**
 * Download one torrent file in an isolated child process.
 * - the child has its own memory cap (TORRENT_WORKER_MB, default 384)
 * - a hard deadline kills it (SIGKILL) even if it hangs
 * - a crash or kill becomes a normal rejected promise; partial files are removed
 * Same contract as the old in-process torrentToFile().
 */
export function torrentInChild(magnet, dest, {
  onProgress, fileIdx, season, episode,
  maxMB = config.maxDownloadMB,
  metadataTimeoutMs = config.torrentMetadataTimeoutMs,
  stallTimeoutMs = config.torrentStallTimeoutMs,
  hardTimeoutMs = Number(process.env.TORRENT_HARD_TIMEOUT_MS) || metadataTimeoutMs + 3 * HOUR,
  workerPath = WORKER,
} = {}) {
  const partsDir = `${dest}.parts`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  cache.markActive(partsDir);
  emit(EVENTS.DOWNLOAD_START, { dest });
  const memoryMB = Math.max(128, Number(process.env.TORRENT_WORKER_MB) || 384);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(workerPath, [], {
      execArgv: [`--max-old-space-size=${memoryMB}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      try { fs.rmSync(partsDir, { recursive: true, force: true }); } catch { /* best effort */ }
      cache.unmarkActive(partsDir);
      if (error) return reject(error);
      metrics.bump('download.bytes', {}, (() => { try { return fs.statSync(result.file).size; } catch { return 0; } })());
      emit(EVENTS.DOWNLOAD_DONE, { dest: result.file });
      return resolve(result);
    };
    const hard = setTimeout(() => finish(Object.assign(new Error(`torrent worker exceeded ${Math.round(hardTimeoutMs / 1000)}s and was killed`), { code: 'TORRENT_TIMEOUT' })), hardTimeoutMs);
    child.on('message', (message) => {
      if (message?.type === 'progress') {
        try { onProgress?.(message.got, message.total); } catch { /* progress is best effort */ }
        emit(EVENTS.DOWNLOAD_PROGRESS, { dest, got: message.got, total: message.total });
      } else if (message?.type === 'done') finish(null, { file: message.file });
      else if (message?.type === 'error') finish(Object.assign(new Error(message.message || 'torrent failed'), message.code ? { code: message.code } : {}));
    });
    child.on('error', (error) => finish(error));
    // A final `done`/`error` message can still be in flight when `exit` fires; give it a moment.
    child.on('exit', (code, signal) => setTimeout(() => finish(Object.assign(new Error(`torrent worker exited early (${signal || `code ${code}`})`), { code: 'TORRENT_WORKER_EXIT' })), 150));
    child.send({ type: 'start', magnet, dest, opts: { fileIdx, season, episode, maxMB, metadataTimeoutMs, stallTimeoutMs } });
  });
}

/**
 * @param {{url:string, kind?:string, headers?:object}} res resolved source
 * @param {string} file destination path
 * @param {(got:number,total:number)=>void} [onProgress]
 */
export async function download(res, file, onProgress) {
  if (!res?.url && !res?.magnet) throw new Error('nothing to download (no link)');
  if (res.kind === 'torrent') {
    return torrentDownloader(res.magnet || res.url, file, {
      onProgress,
      fileIdx: res.fileIdx,
      season: res.season,
      episode: res.episode,
      maxMB: config.maxDownloadMB
    });
  }
  if (res.kind === 'hls') {
    return hlsToFile(res.url, file, onProgress, { headers: res.headers, maxHeight: res.quality });
  }
  return httpToFile(res.url, file, { onProgress, headers: res.headers });
}

let torrentDownloader = torrentInChild;
export const _setTorrentDownloaderForTests = (fn) => { torrentDownloader = fn || torrentInChild; };
