// engine/host.js — bridge from the (generic) engine to the ZaFar Bot host.
//
// The engine ships with the bot, but it is written so it can also run on its
// own: everything host-specific is resolved here, lazily. A bridge that fails
// to load is reported (once) so it cannot degrade silently.
// Using `createRequire` against Node's live CJS cache ensures `.restart`
// (`utils/hotReload.js`) immediately swaps in refreshed host utilities.
import { createRequire } from 'node:module';
import log from './core/log.js';

const req = createRequire(import.meta.url);

const hostLog = log.child('host');
let hostWarned = false;

export async function host() {
  try {
    return req('../host.js') || null;
  } catch (error) {
    // Inside the bot the host bridge always exists; failing to load it means a
    // broken path or module, so say so once instead of silently degrading.
    if (!hostWarned) {
      hostWarned = true;
      hostLog.error(`host bridge failed to load: ${error?.message || error}`);
    }
    return null;
  }
}

/** ffmpeg binary the host already verified (null → engine probes itself). */
export async function ffmpegPath() {
  const h = await host();
  try { return h?.ffmpegPath?.() || null; } catch { return null; }
}

/**
 * High-speed parallel HLS/DASH download through `N_m3u8DL-RE` + `ffmpeg` muxing.
 * Re-throws hard stops (`TOO_BIG`, `ABORTED`) so callers do not retry an
 * oversized or cancelled transfer; returns `null` when unavailable or failed so
 * `hlsToFile` can fall back cleanly to `ffmpeg` / `downloadHlsNative`.
 */
export async function hlsDownload(url, dest, opts = {}) {
  const h = await host();
  if (!h?.hlsDownload) return null;
  try {
    return await h.hlsDownload(url, dest, opts);
  } catch (err) {
    if (err?.code === 'TOO_BIG' || err?.code === 'ABORTED') throw err;
    return null;
  }
}

/**
 * Last-resort download through the host's streamed downloader. DDL hosts
 * sometimes reject Node's fetch fingerprint but accept the bot's agent.
 * @returns {Promise<null|{bytes:number}>} null when the host cannot help
 */
export async function downloadFallback(url, dest, { headers = {}, onProgress, signal, maxBytes } = {}) {
  const h = await host();
  if (!h?.download) return null;
  try {
    const res = await h.download(url, dest, { headers, onProgress, signal, maxBytes });
    return { bytes: res.bytes };
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('download aborted'), { code: 'ABORTED' });
    if (err?.code === 'TOO_BIG') throw err;
    return null;
  }
}
