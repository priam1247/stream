// engine/media/download.js — streamed downloads: never buffer a movie in RAM.
//
// Fixed in the ZaFar Bot integration:
//   • `AbortSignal.timeout(60000)` used to abort the WHOLE transfer after 60
//     seconds — a 2 GB movie over a slow link could never finish. The socket is
//     now guarded by a STALL watchdog (no bytes for `downloadStallMs`), which is
//     what actually needs catching;
//   • downloads are registered with the cache so the disk sweeper can never
//     unlink a file mid-transfer;
//   • optional request headers (Referer/Cookie) for DDL hosts, and automatic
//     retry/resume on a dropped connection;
//   • HLS goes through ffmpeg with the same headers and a stall guard.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import config from '../config.js';
import cache from '../core/cache.js';
import { formatBytes } from '../utils/format.js';
import { freeBytes, ensureDir, which, sanitize as sanitizeName } from '../utils/disk.js';
import { emit, EVENTS } from '../core/events.js';
import { metrics } from '../core/metrics.js';
import { ffmpegPath, downloadFallback, hlsDownload } from '../host.js';
import { downloadHlsNative, parseVariants, chooseVariant } from './hls.js';
import { readPlaylist } from '../utils/httpBody.js';

export const sanitize = (name, q, s, e) => {
  const base = sanitizeName(name);
  const tag = s != null ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : '';
  return [base, tag, `${q}p`, 'x264'].filter(Boolean).join('.') + '.mp4';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Select one video variant and, when present, its separate audio rendition. */
async function resolveFfmpegInputs(url, headers, maxHeight) {
  if (!maxHeight) return { video: url };
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': config.userAgent, accept: '*/*', ...headers },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (!res.ok) { try { await res.body?.cancel(); } catch {} return { video: url }; }
    const text = await readPlaylist(res);
    if (!/#EXT-X-STREAM-INF/i.test(text)) return { video: url };
    const base = res.url || url;
    const chosen = chooseVariant(parseVariants(text, base), maxHeight);
    if (!chosen?.url) return { video: url };
    const validHttp = (value) => {
      try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
    };
    if (!validHttp(chosen.url)) throw new Error('invalid HLS variant URL');

    const audio = text.split(/\r?\n/).filter((line) => {
      if (!/^#EXT-X-MEDIA:/i.test(line) || !/(?:^|[:,])TYPE=AUDIO(?:,|$)/i.test(line)) return false;
      return /(?:^|[:,])GROUP-ID="([^"]+)"/i.exec(line)?.[1] === chosen.audioGroup && /(?:^|[:,])URI="[^"]+"/i.test(line);
    }).sort((a, b) => Number(/(?:^|[:,])DEFAULT=YES(?:,|$)/i.test(b)) - Number(/(?:^|[:,])DEFAULT=YES(?:,|$)/i.test(a)))[0];
    const audioUri = audio && /(?:^|[:,])URI="([^"]+)"/i.exec(audio)?.[1];
    const audioUrl = audioUri ? new URL(audioUri, base).toString() : null;
    if (audioUrl && !validHttp(audioUrl)) throw new Error('invalid HLS audio URL');
    return { video: chosen.url, ...(audioUrl ? { audio: audioUrl } : {}) };
  } catch (error) {
    if (error.code === 'TOO_BIG') throw error;
    return { video: url };
  }
}

// HLS -> file, straight to disk.
// 3-tier cascade:
//   1. `N_m3u8DL-RE` (16 parallel segment threads + `ffmpeg` MP4 mux, honours `maxHeight`)
//   2. `ffmpeg` HLS remux (honours `maxHeight` on muxed master playlists)
//   3. `downloadHlsNative` (pure Node.js segment concatenation + AES-128 decryption)
export async function hlsToFile(url, dest, onProgress, { headers = {}, maxHeight, onAbort } = {}) {
  ensureDir(path.dirname(dest));
  cache.markActive(dest);
  emit(EVENTS.DOWNLOAD_START, { dest });

  // hard cap so a runaway playlist can never eat the host's disk
  const maxBytes = Math.round(config.maxDownloadMB * config.downloadCapFactor * 1048576);
  const hlsMode = String(process.env.MOVIE_HLS_ENGINE || 'auto').toLowerCase();

  try {
    // ── Tier 1: N_m3u8DL-RE parallel segment downloader + ffmpeg MP4 muxer ──
    if (hlsMode !== 'ffmpeg' && hlsMode !== 'native' && hlsMode !== 'off') {
      const viaRe = await hlsDownload(url, dest, {
        headers,
        maxHeight,
        maxBytes,
        stallMs: config.downloadStallMs,
        onProgress,
        onAbort,
      });
      if (viaRe && viaRe.bytes > 0) {
        metrics.bump('download.bytes', {}, viaRe.bytes);
        emit(EVENTS.DOWNLOAD_DONE, { dest: viaRe.file, bytes: viaRe.bytes });
        return { bytes: viaRe.bytes, file: viaRe.file, engine: 'nm3u8dl-re' };
      }
    }

    // ── Tier 2: ffmpeg HLS remux ────────────────────────────────────────────
    const ffmpeg = hlsMode === 'native' ? null : ((await ffmpegPath()) || await which('ffmpeg'));
    if (ffmpeg) {
      const inputs = await resolveFfmpegInputs(url, headers, maxHeight);
      const headerLines = Object.entries({ 'User-Agent': config.userAgent, ...headers })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const inputArgs = (input) => [
        '-headers', `${headerLines}\r\n`,
        '-user_agent', config.userAgent,
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
        '-i', input,
      ];

      try {
        await new Promise((resolve, reject) => {
          const p = execFile(ffmpeg, [
            '-y', '-hide_banner', '-loglevel', 'error',
            ...inputArgs(inputs.video),
            ...(inputs.audio ? [...inputArgs(inputs.audio), '-map', '0:v:0', '-map', '1:a:0'] : []),
            '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
            '-movflags', '+faststart',
            dest
          ], { maxBuffer: 1 << 24 });

          let lastSize = 0, lastChange = Date.now();
          const tick = setInterval(() => {
            if (onAbort?.()) {
              clearInterval(tick);
              try { p.kill('SIGKILL'); } catch {}
              return reject(Object.assign(new Error('download aborted'), { code: 'ABORTED' }));
            }
            try {
              const s = fs.statSync(dest).size;
              if (maxBytes > 0 && s > maxBytes) {
                clearInterval(tick);
                try { p.kill('SIGKILL'); } catch {}
                return reject(Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' }));
              }
              if (s !== lastSize) { lastSize = s; lastChange = Date.now(); onProgress?.(s, 0); }
              else if (Date.now() - lastChange > config.downloadStallMs) {
                clearInterval(tick);
                try { p.kill('SIGKILL'); } catch {}
                return reject(new Error('HLS stream stalled (no data) — link expired?'));
              }
            } catch { /* file not created yet */ }
          }, 4000);

          p.on('error', (e) => { clearInterval(tick); reject(e); });
          p.on('close', (c) => { clearInterval(tick); c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)); });
        });

        const bytes = fs.statSync(dest).size;
        if (maxBytes > 0 && bytes > maxBytes) {
          throw Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' });
        }
        if (bytes >= 10 * 1024) {
          metrics.bump('download.bytes', {}, bytes);
          emit(EVENTS.DOWNLOAD_DONE, { dest, bytes });
          return { bytes, file: dest, engine: 'ffmpeg' };
        }
        try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      } catch (ffErr) {
        try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
        if (ffErr?.code === 'TOO_BIG' || ffErr?.code === 'ABORTED') throw ffErr;
        // Any other ffmpeg HLS failure falls through to pure-JS segment fetch
      }
    }

    // ── Tier 3: pure Node.js segment concatenation + AES-128 decryption ─────
    let got;
    try {
      const wrappedProgress = typeof onProgress === 'function'
        ? (done, total, bytes) => {
            const estTotal = total > 0 && done > 0 ? Math.round((bytes / done) * total) : 0;
            onProgress(bytes, estTotal);
          }
        : undefined;
      got = await downloadHlsNative(url, dest, { headers, onProgress: wrappedProgress, onAbort, maxHeight, maxBytes });
    } catch (e) {
      // never leave a half-written stream behind for the next retry to resume
      for (const f of [dest, dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + '.ts']) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
      throw e;
    }
    metrics.bump('download.bytes', {}, got.bytes);
    emit(EVENTS.DOWNLOAD_DONE, { dest: got.file, bytes: got.bytes });
    return { bytes: got.bytes, file: got.file, native: true, engine: 'native' };
  } finally {
    cache.unmarkActive(dest);
  }
}

// One HTTP attempt. Resumes from whatever is already on disk.
async function httpAttempt(url, dest, { onProgress, onAbort, headers, signal, maxBytes }) {
  let start = 0;
  try { if (fs.existsSync(dest)) start = fs.statSync(dest).size; } catch { /* ignore */ }
  const tooBig = () => Object.assign(new Error('download is larger than the size cap'), { code: 'TOO_BIG' });
  if (maxBytes > 0 && start > maxBytes) throw tooBig();

  const res = await fetch(url, {
    headers: {
      'user-agent': config.userAgent,
      ...headers,
      ...(start ? { range: `bytes=${start}-` } : {})
    },
    signal,
    redirect: 'follow'
  });
  const cancel = async () => { try { await res.body?.cancel(); } catch { /* already closed */ } };

  if (res.status === 416 && start) {
    const total = /^bytes \*\/(\d+)$/i.exec(res.headers.get('content-range') || '')?.[1];
    await cancel();
    if (Number(total) === start) return { bytes: start, complete: true };
    // A stale partial is not a completed file. Discard it and make one clean
    // request instead of sending corrupt data or retrying the same bad range.
    fs.rmSync(dest, { force: true });
    return httpAttempt(url, dest, { onProgress, onAbort, headers, signal, maxBytes });
  }
  if (!res.ok && res.status !== 206) { await cancel(); throw new Error(`HTTP ${res.status}`); }

  // A server that ignores Range is safe to restart from zero. A 206 response
  // must begin at the requested offset or appending it would corrupt the file.
  if (start && res.status !== 206) start = 0;
  else if (start) {
    const offset = /^bytes (\d+)-\d+\/(?:\d+|\*)$/i.exec(res.headers.get('content-range') || '')?.[1];
    if (Number(offset) !== start) {
      await cancel();
      fs.rmSync(dest, { force: true });
      return httpAttempt(url, dest, { onProgress, onAbort, headers, signal, maxBytes });
    }
  }

  const total = Number(res.headers.get('content-length') || 0) + start;
  if (maxBytes > 0 && total > maxBytes) { await cancel(); throw tooBig(); }
  const free = await freeBytes(path.dirname(dest));
  if (free !== null && total && free < total + 300 * 1048576) {
    await cancel();
    throw new Error(`low disk: need ${formatBytes(total)}, have ${formatBytes(free)}`);
  }
  if (!res.body) throw new Error('download response has no body');

  let got = start, last = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      if (onAbort?.()) return callback(Object.assign(new Error('download aborted'), { code: 'ABORTED' }));
      got += chunk.length;
      if (maxBytes > 0 && got > maxBytes) return callback(tooBig());
      const now = Date.now();
      if (now - last > 4000) {
        last = now;
        try { onProgress?.(got, total); } catch { /* progress is best effort */ }
        emit(EVENTS.DOWNLOAD_PROGRESS, { dest, got, total });
      }
      callback(null, chunk);
    }
  });
  // pipeline handles backpressure, write errors (including ENOSPC), and closes
  // both the response and destination on failure.
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest, { flags: start ? 'a' : 'w' }), { signal });
  if (total && got < total) throw new Error(`incomplete download (${got}/${total} bytes)`);
  return { bytes: got, complete: true };
}

// streamed HTTPS download with stall guard, resume and retries
export async function httpToFile(url, dest, { onProgress, onAbort, headers = {} } = {}) {
  ensureDir(path.dirname(dest));
  cache.markActive(dest);                 // a partial file must survive the sweeper
  emit(EVENTS.DOWNLOAD_START, { dest });
  const maxBytes = Math.round(config.maxDownloadMB * config.downloadCapFactor * 1048576);

  try {
    let lastErr;
    for (let attempt = 0; attempt <= config.downloadRetries; attempt++) {
      // a FRESH controller per attempt: a stalled attempt must not poison the retry
      const controller = new AbortController();
      let lastData = Date.now();
      const guard = setInterval(() => {
        if (onAbort?.() || Date.now() - lastData > config.downloadStallMs) controller.abort();
      }, 5000);
      guard.unref?.();

      try {
        const out = await httpAttempt(url, dest, {
          onProgress: (got, total) => { lastData = Date.now(); onProgress?.(got, total); },
          onAbort, headers, signal: controller.signal, maxBytes,
        });
        metrics.bump('download.bytes', {}, out.bytes);
        emit(EVENTS.DOWNLOAD_DONE, { dest, bytes: out.bytes });
        return out;
      } catch (e) {
        lastErr = e;
        const cancelled = e.code === 'ABORTED' || Boolean(onAbort?.());
        if (cancelled || ['TOO_BIG', 'ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM'].includes(e.code)) {
          try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
          if (cancelled && e.code !== 'ABORTED') throw Object.assign(new Error('download aborted'), { code: 'ABORTED' });
          throw e;
        }
        const stalled = e.name === 'AbortError' || /aborted|stalled/i.test(e.message || '');
        if (attempt >= config.downloadRetries) {
          // Last resort: the bot's own downloader (different TLS/agent stack).
          // Some hosts reject Node's fetch fingerprint but serve axios.
          try {
            fs.rmSync(dest, { force: true });     // restart clean: host has no resume
          } catch { /* ignore */ }
          const fallbackController = new AbortController();
          if (onAbort?.()) fallbackController.abort();
          const cancelGuard = setInterval(() => { if (onAbort?.()) fallbackController.abort(); }, 250);
          cancelGuard.unref?.();
          let viaHost;
          try {
            viaHost = await downloadFallback(url, dest, { headers, onProgress, maxBytes, signal: fallbackController.signal });
          } finally { clearInterval(cancelGuard); }
          if (viaHost && viaHost.bytes > 0) {
            metrics.bump('download.bytes', {}, viaHost.bytes);
            emit(EVENTS.DOWNLOAD_DONE, { dest, bytes: viaHost.bytes });
            return { bytes: viaHost.bytes, viaHost: true };
          }
          if (stalled) throw new Error('download stalled — the source stopped sending data');
          throw e;
        }
        await sleep(1500 * (attempt + 1));
      } finally {
        clearInterval(guard);
      }
    }
    throw lastErr;
  } finally {
    cache.unmarkActive(dest);
  }
}
