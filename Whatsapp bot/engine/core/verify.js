// engine/core/verify.js — truth-checking before download.
//
// Fixed in the ZaFar Bot integration:
//   • many DDL hosts answer HEAD with 405/403 — verification now falls back to a
//     1-byte ranged GET before declaring a link dead
//   • HLS playlists are checked with a small GET for #EXTM3U (HEAD on a manifest
//     usually fails), so an expired stream is caught before ffmpeg starts
//   • the sample-size floor is configurable (a 45 MB 480p episode is not a sample)
//   • per-candidate Referer/Cookie headers are honoured
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import config from '../config.js';
import { which } from '../utils/disk.js';
import { readPlaylist } from '../utils/httpBody.js';
import { metrics } from './metrics.js';
import { emit, EVENTS } from './events.js';

const exec = (bin, args, ms = 20000) => new Promise((res, rej) => {
  const p = execFile(bin, args, { timeout: ms, maxBuffer: 1 << 22 }, (e, o) => e ? rej(e) : res(o));
  p.on('error', rej);
});

export const MAGIC = [
  { name: 'mp4', test: (b) => b.length > 11 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { name: 'mkv/webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { name: 'avi', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'AVI ' },
  { name: 'mpegts', test: (b) => b.length > 188 && b[0] === 0x47 && b[188] === 0x47 }
];

export function sniffContainer(buf) {
  for (const m of MAGIC) if (m.test(buf)) return m.name;
  return null;
}

const ua = () => config.userAgent;
const tmo = (ms) => AbortSignal.timeout(ms);

// Some video hosts ignore Range and return an entire multi-gigabyte file with
// status 200. Read and retain only the requested prefix, then cancel the body.
async function readPrefix(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(Buffer.from(value.subarray(0, take)));
      total += take;
    }
    return Buffer.concat(chunks, total);
  } finally {
    try { await reader.cancel(); } catch { /* connection already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** HEAD first, then a 1-byte ranged GET — many hosts refuse HEAD. */
async function sizeOf(url, headers) {
  const h = { 'user-agent': ua(), ...headers };
  try {
    const head = await fetch(url, { method: 'HEAD', headers: h, signal: tmo(config.verifyTimeoutMs), redirect: 'follow' });
    if (head.ok) {
      const len = Number(head.headers.get('content-length') || 0);
      if (len) return { sizeMB: len / 1048576, ok: true, type: head.headers.get('content-type') || '' };
    }
  } catch { /* fall through to range GET */ }

  try {
    const res = await fetch(url, {
      headers: { ...h, range: 'bytes=0-0' },
      signal: tmo(config.verifyTimeoutMs), redirect: 'follow'
    });
    if (!res.ok && res.status !== 206) {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      return { ok: false, status: res.status };
    }
    const cr = res.headers.get('content-range');           // "bytes 0-0/1234567"
    const total = Number(String(cr || '').split('/')[1] || res.headers.get('content-length') || 0);
    try { await res.body?.cancel(); } catch {}
    return { ok: true, sizeMB: total ? total / 1048576 : 0, type: res.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, status: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

export async function probeRange(url, bytes = config.verifyBytes, headers = {}) {
  const ffprobe = await which('ffprobe');
  if (!ffprobe) return null;
  const limit = Math.max(1, Math.min(32 * 1048576, Math.floor(Number(bytes) || 0)));

  const res = await fetch(url, {
    headers: { ...headers, 'user-agent': ua(), range: `bytes=0-${limit - 1}` },
    signal: tmo(config.verifyTimeoutMs), redirect: 'follow'
  });
  if (!res.ok && res.status !== 206) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`range ${res.status}`);
  }

  const buf = await readPrefix(res, limit);
  if (buf.length < 20000) throw new Error('suspiciously small header');

  // Separate directories avoid concurrent probes clobbering the same file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-probe-'));
  const tmp = path.join(dir, 'header.bin');
  try {
    fs.writeFileSync(tmp, buf);
    const out = await exec(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=height,codec_name,width',
      '-show_entries', 'format=duration',
      '-of', 'json', tmp
    ]);
    return JSON.parse(out);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// download just the first 512 bytes and identify the container
export async function sniffRemote(url, headers = {}) {
  const res = await fetch(url, {
    headers: { ...headers, 'user-agent': ua(), range: 'bytes=0-511' },
    signal: tmo(config.verifyTimeoutMs), redirect: 'follow'
  });
  if (!res.ok && res.status !== 206) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`sniff ${res.status}`);
  }
  const buf = await readPrefix(res, 512);
  if (buf.length < 16) return null;
  return sniffContainer(buf);
}

/** HLS: confirm the manifest is real and still alive. */
async function verifyHls(cand) {
  // HLS no longer needs ffmpeg (engine/media/hls.js downloads the segments
  // itself), so a live manifest is all we check.
  const res = await fetch(cand.url, {
    headers: { ...cand.headers, 'user-agent': ua() },
    signal: tmo(config.verifyTimeoutMs), redirect: 'follow'
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`stream dead (${res.status})`);
  }
  const text = await readPlaylist(res);
  if (!/#EXTM3U/i.test(text)) throw new Error('not an HLS playlist');
  const variants = (text.match(/#EXT-X-STREAM-INF/gi) || []).length;
  if (!variants && !/#EXTINF/i.test(text)) throw new Error('empty HLS playlist');
  metrics.bump('verify.ok');
  return { url: cand.url, sizeMB: 0, verified: true, kind: 'hls', variants };
}

export async function verify(cand, opts = {}) {
  const url = cand.url;
  if (!url) throw new Error('no url');

  if (cand.kind === 'hls') return verifyHls(cand);

  const headers = cand.headers || {};
  const probe = await sizeOf(url, headers);

  if (!probe.ok) {
    if (/text\/html/i.test(probe.type || '')) throw new Error('link returned a web page, not a video');
    throw new Error(`dead link ${probe.status ?? 'unreachable'}`);
  }

  let sizeMB = probe.sizeMB || cand.sizeMB || 0;

  if (sizeMB && sizeMB < config.minSampleMB) {
    metrics.bump('verify.fail');
    throw new Error(`too small (${sizeMB.toFixed(0)}MB) — likely a sample`);
  }
  // Reject only genuinely absurd files. The old check used the WhatsApp send
  // cap, so a normal 1080p movie (2–4 GB) was thrown away as "too big" and the
  // user got "no usable source found" for every title.
  if (sizeMB && sizeMB > config.maxDownloadMB * 1.4) {
    metrics.bump('verify.fail');
    throw new Error(`too big (${sizeMB.toFixed(0)}MB, cap ${config.maxDownloadMB}MB)`);
  }

  // quality truth-check (only when ffprobe exists)
  if (cand.quality) {
    const ffprobe = await which('ffprobe');
    if (ffprobe) {
      try {
        const p = await probeRange(url, config.verifyBytes, headers);
        const h = p?.streams?.[0]?.height;
        if (h && Math.abs(h - cand.quality) > 240) {
          metrics.bump('verify.fail');
          throw new Error(`quality mismatch: labelled ${cand.quality}p, actually ${h}p`);
        }
        metrics.bump('verify.ok');
        emit(EVENTS.VERIFY_OK, { provider: cand.provider || 'unknown', height: h });
        return { url, sizeMB, probe: p, verified: true, headers };
      } catch (e) {
        if (/mismatch|small|too big/.test(e.message)) throw e;
        // probe inconclusive → fall through to the magic-byte check
      }
    }
  }

  // magic bytes prove it is a real video file and not an HTML error page
  const container = await sniffRemote(url, headers).catch(() => undefined);
  if (container === null || (container === undefined && sizeMB > 0 && /text\/html/i.test(probe.type || ''))) {
    metrics.bump('verify.fail');
    throw new Error('unrecognized container (not mp4/mkv/webm/avi/ts)');
  }

  metrics.bump('verify.ok');
  return { url, sizeMB, verified: Boolean(container), container, headers };
}
