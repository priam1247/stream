'use strict';

/**
 * commands/sticker/ffmpeg.js — exactly one ffmpeg binary.
 *
 * The old utils/ffmpeg.js resolved a system binary and fell back to the
 * packaged one. Two paths meant a broken system install silently produced
 * different output. Here: the packaged binary is the path; if it cannot run,
 * the command throws and says so.
 */

const { execFile } = require('child_process');

let cached = null;

function ffmpegPath() {
  if (cached) return cached;
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer?.path) {
      cached = installer.path;
      return cached;
    }
  } catch (err) {
    const error = new Error(`the packaged ffmpeg is not installed: ${err.message}`);
    error.code = 'FFMPEG_MISSING';
    throw error;
  }
  const error = new Error('the packaged ffmpeg did not report a binary path');
  error.code = 'FFMPEG_MISSING';
  throw error;
}

function runFfmpeg(args, log) {
  const bin = ffmpegPath();
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const tail = String(stderr || '').trim().split('\n').slice(-2).join(' | ');
      log?.error(`ffmpeg failed: ${tail || err.message}`);
      const error = new Error(`ffmpeg failed: ${tail || err.message}`);
      error.code = 'FFMPEG_FAILED';
      error.cause = err;
      reject(error);
    });
  });
}

module.exports = { ffmpegPath, runFfmpeg, _reset: () => { cached = null; } };
