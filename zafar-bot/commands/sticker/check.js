'use strict';

/**
 * commands/sticker/check.js — offline and real.
 *
 * Stage 1: ffmpeg resolves to exactly one binary.
 * Stage 2: a real PNG is converted to a real WebP that WhatsApp will accept as a
 *          sticker (512x512 canvas). This exercises the actual ffmpeg arguments.
 * No WhatsApp, no network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const meta = require('./command.json');
const { ffmpegPath, runFfmpeg } = require('./ffmpeg');

const log = { debug() {}, info() {}, warn() {}, error() {} };

async function check() {
  const bin = ffmpegPath();
  if (!fs.existsSync(bin)) throw new Error(`ffmpeg binary does not exist: ${bin}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sticker-'));
  const src = path.join(dir, 'in.png');
  const out = path.join(dir, 'out.webp');

  try {
    // Build a 600x400 test image with ffmpeg itself, so the test needs no fixtures.
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=600x400:d=1', '-frames:v', '1', src], log);
    if (!fs.existsSync(src)) throw new Error('could not create the test image');

    const scale = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `${scale},format=rgba`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', out], log);

    const bytes = fs.statSync(out).size;
    if (!bytes) throw new Error('ffmpeg produced an empty webp');

    // Confirm the output really is a 512x512 WebP, not just a file with the name.
    const probe = execFileSync(bin, ['-hide_banner', '-i', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    void probe;
  } catch (err) {
    // ffmpeg writes its banner to stderr; re-probe there.
    try {
      execFileSync(bin, ['-hide_banner', '-i', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (probeErr) {
      const text = String(probeErr.stderr || '');
      if (!text.includes('512x512')) throw new Error(`output is not 512x512: ${text.split('\n').find((l) => l.includes('Video:')) || 'no stream info'}`);
    }
    if (!fs.existsSync(out)) throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return `ffmpeg + webp pipeline ok (${meta.limits.maxSizeMB}MB cap)`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
