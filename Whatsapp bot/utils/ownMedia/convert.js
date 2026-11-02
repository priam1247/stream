'use strict';

/**
 * Brick 5 — ffmpeg.
 *
 * @ffmpeg-installer/ffmpeg is already a locked dependency of this bot, so a
 * working binary is available even on panels with no system ffmpeg and no
 * yt-dlp. Every conversion goes through utils/ffmpeg.js (the single resolver).
 * When ffmpeg is genuinely missing the engine still sends the raw stream.
 */

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const C = require('./constants');
const { EngineError } = require('./http');
const mediaTransfer = require('../mediaTransfer');
const resolveFfmpeg = require('../ffmpeg');

const execFileAsync = promisify(execFile);

function works() {
  try { return Boolean(resolveFfmpeg.works()); }
  catch { return false; }
}

async function run(args, timeout = C.FFMPEG_TIMEOUT_MS) {
  if (!works()) throw new EngineError('FFMPEG_MISSING', 'No runnable ffmpeg binary on this host');
  const binary = resolveFfmpeg();
  try {
    await execFileAsync(binary, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      timeout, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    throw new EngineError('FFMPEG_FAILED', String(err.stderr || err.message).trim().split('\n').pop());
  }
}

/** Any input ffmpeg can read (file or manifest URL) → MP3. */
async function toMp3(input, output, timeout = C.FFMPEG_TIMEOUT_MS) {
  await run(['-i', input, '-vn', '-ac', '2', '-codec:a', 'libmp3lame', '-q:a', '0',
    '-compression_level', '0', '-f', 'mp3', output], timeout);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
    throw new EngineError('FFMPEG_FAILED', 'ffmpeg produced no MP3');
  }
  return output;
}

/** Combine a video-only and an audio-only stream into one MP4. */
async function mux(videoFile, audioFile, output, timeout = C.FFMPEG_TIMEOUT_MS) {
  await run(['-i', videoFile, '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-f', 'mp4', output], timeout);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
    throw new EngineError('FFMPEG_FAILED', 'ffmpeg produced no MP4');
  }
  return output;
}

/** HLS/DASH manifest → MP3 or MP4 (ffmpeg reads the manifest URL itself). */
async function fromManifest(url, output, kind, timeout = C.FFMPEG_TIMEOUT_MS) {
  const args = kind === 'audio'
    ? ['-i', url, '-vn', '-ac', '2', '-codec:a', 'libmp3lame', '-q:a', '0', '-f', 'mp3', output]
    : ['-i', url, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output];
  await run(args, timeout);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
    throw new EngineError('FFMPEG_FAILED', 'ffmpeg produced no output from the manifest');
  }
  return output;
}

/** Reuse the bot's WhatsApp-compatible remux/transcode helper. */
const ensurePlayable = (input, output) => mediaTransfer.ensureWhatsAppMp4(input, output, {
  timeoutMs: C.FFMPEG_TIMEOUT_MS,
});

module.exports = { works, run, toMp3, mux, fromManifest, ensurePlayable };
