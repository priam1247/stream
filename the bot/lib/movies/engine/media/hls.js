// engine/media/hls.js — HLS downloader that needs NO ffmpeg.
//
// The host this bot runs on has no ffmpeg (the panel blocks npm install
// scripts, and the image ships without it), so "ffmpeg required for HLS" meant
// every stream source died at download time. This module fetches the playlist,
// picks the variant, downloads the segments and concatenates them:
//
//   • fMP4 playlists (#EXT-X-MAP) → init.mp4 + segments  → a valid .mp4
//   • TS playlists                → consecutive .ts chunks → one .ts file
//   • AES-128 encrypted segments  → decrypted with node:crypto
//
// Quality is honest: the requested height is matched against the master
// playlist's RESOLUTION lines, so a 720p request never silently pulls 1080p.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { readBounded, readPlaylist } from '../utils/httpBody.js';

const UA = () => config.userAgent;
const rawConcurrency = Number(process.env.HLS_CONCURRENCY || 4);
const SEGMENT_CONCURRENCY = Number.isFinite(rawConcurrency) && rawConcurrency >= 1
  ? Math.min(16, Math.floor(rawConcurrency)) : 4;
// Native fallback buffers individual segments for AES decryption. Bound those
// buffers even when an upstream host ignores the requested download size cap.
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;

const request = (url, headers = {}, timeoutMs, signal) => {
  const timeout = AbortSignal.timeout(timeoutMs || Math.max(20000, config.verifyTimeoutMs * 3));
  return fetch(url, {
    headers: { 'user-agent': UA(), accept: '*/*', ...headers },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'follow'
  });
};

const abs = (u, base) => { try { return new URL(u, base).toString(); } catch { return u; } };

/**
 * Master playlist → [{height, bandwidth, url}] sorted best-first.
 * Line based (not one big regex) so blank lines, CRLF and #EXT-X-I-FRAME
 * entries cannot swallow the next URI.
 */
export function parseVariants(playlist, baseUrl) {
  const out = [];
  const lines = String(playlist || '').split(/\r?\n/).map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const height = Number(/RESOLUTION=\d+x(\d+)/i.exec(line)?.[1] || 0);
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] || 0);
    const audioGroup = /(?:^|[:,])AUDIO="([^"]+)"/i.exec(line)?.[1] || null;
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    out.push({ height, bandwidth, url: abs(lines[j], baseUrl), audioGroup });
    i = j;
  }
  return out.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

/** Pick the variant closest to (and not above) the wanted height. */
export function chooseVariant(variants, want) {
  if (!variants.length) return null;
  const target = Number(want) || 0;
  if (!target) return variants[0];
  const atOrBelow = variants.filter(v => v.height && v.height <= target + 60);
  if (atOrBelow.length) return atOrBelow[0];          // already sorted best-first
  return variants[variants.length - 1];               // nothing that small → lowest
}

/** Media playlist → { segments, initUrl, mediaSequence, encrypted } */
export function parseMedia(playlist, baseUrl) {
  const lines = String(playlist || '').split(/\r?\n/).map(l => l.trim());
  const segments = [];
  let initUrl = null;
  let initKey = null;
  let key = null;
  let mediaSequence = 0;
  let encrypted = false;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      throw new Error('HLS byte ranges require ffmpeg or N_m3u8DL-RE');
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      if (/(?:^|[:,])BYTERANGE=/i.test(line)) throw new Error('HLS initialization byte range requires ffmpeg or N_m3u8DL-RE');
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (!uri) throw new Error('HLS initialization map URI is missing');
      const nextUrl = abs(uri, baseUrl);
      if (segments.length && (nextUrl !== initUrl || JSON.stringify(key) !== JSON.stringify(initKey))) {
        throw new Error('changing HLS initialization maps require ffmpeg or N_m3u8DL-RE');
      }
      if (key && !key.iv) throw new Error('encrypted HLS initialization map requires an explicit IV');
      initUrl = nextUrl;
      initKey = key;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = (/METHOD=([A-Z0-9-]+)/i.exec(line)?.[1] || '').toUpperCase();
      const uri = /URI="([^"]+)"/i.exec(line)?.[1];
      const keyFormat = /KEYFORMAT="([^"]+)"/i.exec(line)?.[1] || 'identity';
      if (method === 'NONE') key = null;
      else if (method === 'AES-128' && keyFormat.toLowerCase() === 'identity') {
        if (!uri) throw new Error('HLS encryption key URI is missing');
        const iv = /IV=0x([0-9a-fA-F]+)/i.exec(line)?.[1] || null;
        if (iv && iv.length > 32) throw new Error('invalid HLS AES IV');
        key = { uri: abs(uri, baseUrl), iv };
        encrypted = true;
      } else {
        throw new Error(`unsupported HLS encryption: ${method || 'unknown'}`);
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    segments.push({ url: abs(line, baseUrl), key });
  }

  return { segments, initUrl, initKey, mediaSequence, encrypted };
}

async function fetchKey(keyInfo, headers, signal) {
  const res = await request(keyInfo.uri, headers, undefined, signal);
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`HLS key HTTP ${res.status}`);
  }
  const key = await readBounded(res, 16, 'HLS key');
  if (key.length !== 16) throw new Error('invalid AES-128 HLS key length');
  return key;
}

function decrypt(buffer, key, ivHex, seq) {
  const iv = ivHex
    ? Buffer.from(ivHex.padStart(32, '0').slice(0, 32), 'hex')
    : (() => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(seq), 8); return b; })();
  const attempt = (autoPadding) => {
    const dec = crypto.createDecipheriv('aes-128-cbc', key, iv);
    dec.setAutoPadding(autoPadding);
    return Buffer.concat([dec.update(buffer), dec.final()]);
  };
  try { return attempt(true); }
  catch { return attempt(false); } // some encoders omit PKCS#7 padding
}

/** Download one bounded segment (with one retry) into memory. */
async function fetchSegment(seg, headers, timeoutMs, maxBytes, signal) {
  const limit = Math.min(MAX_SEGMENT_BYTES, maxBytes > 0 ? maxBytes + 16 : MAX_SEGMENT_BYTES);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await request(seg.url, headers, timeoutMs, signal);
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* already closed */ }
        throw new Error(`HLS segment HTTP ${res.status}`);
      }
      return await readBounded(res, limit, 'HLS segment');
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      if (e.code === 'TOO_BIG' || attempt >= 1) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

/**
 * Download an HLS stream to disk with no external tools.
 * Writes init + segments into ONE file, honouring the real container:
 * a TS playlist becomes `.ts`, a fragmented-MP4 playlist becomes `.mp4`.
 *
 * @returns {Promise<{file:string, bytes:number, variant:number}>}
 */
export async function downloadHlsNative(url, dest, options = {}) {
  const controller = new AbortController();
  const abortError = Object.assign(new Error('download aborted'), { code: 'ABORTED' });
  let cancelled = false;
  const check = () => {
    if (options.onAbort?.()) { cancelled = true; controller.abort(abortError); }
  };
  check();
  const timer = setInterval(check, 250);
  timer.unref?.();
  try {
    if (cancelled) throw abortError;
    return await downloadHlsNativeInner(url, dest, { ...options, signal: controller.signal });
  } catch (error) {
    if (cancelled) throw abortError;
    throw error;
  } finally {
    clearInterval(timer);
    controller.abort(); // stop any segment requests left in flight after a failure
  }
}

async function downloadHlsNativeInner(url, dest, { headers = {}, onProgress, maxHeight, maxBytes, signal } = {}) {
  let playlistUrl = url;
  const masterRes = await request(playlistUrl, headers, undefined, signal);
  if (!masterRes.ok) {
    try { await masterRes.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`HLS playlist HTTP ${masterRes.status}`);
  }
  playlistUrl = masterRes.url || playlistUrl;
  let text = await readPlaylist(masterRes);

  if (!/#EXTM3U/i.test(text)) throw new Error('not an HLS playlist');

  let variantHeight = 0;
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const variants = parseVariants(text, playlistUrl);
    const chosen = chooseVariant(variants, maxHeight);
    if (!chosen) throw new Error('HLS master playlist has no variants');
    const separateAudio = chosen.audioGroup && text.split(/\r?\n/).some((line) => {
      if (!/^#EXT-X-MEDIA:/i.test(line) || !/(?:^|[:,])TYPE=AUDIO(?:,|$)/i.test(line)) return false;
      return /(?:^|[:,])GROUP-ID="([^"]+)"/i.exec(line)?.[1] === chosen.audioGroup && /(?:^|[:,])URI="[^"]+"/i.test(line);
    });
    if (separateAudio) throw new Error('separate audio rendition requires ffmpeg or N_m3u8DL-RE');
    playlistUrl = chosen.url;
    variantHeight = chosen.height;
    const res = await request(playlistUrl, headers, undefined, signal);
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      throw new Error(`HLS variant HTTP ${res.status}`);
    }
    playlistUrl = res.url || playlistUrl;
    text = await readPlaylist(res);
  }

  if (!/#EXT-X-ENDLIST\b/i.test(text)) throw new Error('live HLS requires ffmpeg or N_m3u8DL-RE');
  const { segments, initUrl, initKey, mediaSequence, encrypted } = parseMedia(text, playlistUrl);
  if (!segments.length) throw new Error('HLS playlist has no segments');

  // Container decision: sniff the first decrypted payload, not the URL.
  const firstKey = initUrl ? initKey : segments[0].key;
  const firstBuf = await fetchSegment(initUrl ? { url: initUrl, key: initKey } : segments[0], headers, undefined, maxBytes, signal);
  const first = firstKey
    ? decrypt(firstBuf, await fetchKey(firstKey, headers, signal), firstKey.iv, mediaSequence)
    : firstBuf;
  const isTs = first.length > 188 && first[0] === 0x47 && first[188] === 0x47;
  const ext = isTs ? '.ts' : '.mp4';

  const outPath = dest.toLowerCase().endsWith(ext) ? dest : dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + ext;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const fd = fs.openSync(outPath, 'w');
  let bytes = 0;
  let done = 0;
  const total = segments.length + (initUrl ? 1 : 0);
  const keys = new Map();

  const write = (buf) => {
    if (maxBytes && bytes + buf.length > maxBytes) {
      throw Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' });
    }
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset);
      if (!written) throw new Error('could not write HLS output');
      offset += written;
    }
    bytes += buf.length;
    done += 1;
    try { onProgress?.(done, total, bytes); } catch { /* progress is best effort */ }
  };

  const keyFor = async (keyInfo) => {
    if (!keyInfo) return null;
    const cacheKey = keyInfo.uri;
    if (!keys.has(cacheKey)) keys.set(cacheKey, fetchKey(keyInfo, headers, signal));
    return keys.get(cacheKey);
  };

  let completed = false;
  try {
    write(first);                                   // init, or segment #0
    const start = initUrl ? 0 : 1;                  // segment #0 already written

    // Bounded concurrency and per-segment limits protect the host's memory.
    for (let i = start; i < segments.length; i += SEGMENT_CONCURRENCY) {
      const chunk = segments.slice(i, i + SEGMENT_CONCURRENCY);
      const buffers = await Promise.all(chunk.map(async (seg, offset) => {
        const raw = await fetchSegment(seg, headers, undefined, maxBytes, signal);
        const key = await keyFor(seg.key);
        return key ? decrypt(raw, key, seg.key.iv, mediaSequence + i + offset) : raw;
      }));
      for (const buf of buffers) write(buf);
    }
    if (bytes < 10 * 1024) throw new Error('HLS download produced no data');
    completed = true;
    return { file: outPath, bytes, variant: variantHeight, encrypted, segments: segments.length };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    if (!completed) { try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ } }
  }
}

export default { downloadHlsNative, parseVariants, parseMedia, chooseVariant };
