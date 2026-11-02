'use strict';

/**
 * commands/video/check.js — live self-test against the real KnightBot endpoint.
 * Downloads to a temp folder, deletes it, never sends.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const meta = require('./command.json');
const search = require('./search');
const knightbot = require('./knightbot');

const log = { debug() {}, info() {}, warn() {}, error() {} };

async function check() {
  const started = Date.now();
  const tmp = path.join(os.tmpdir(), `check-video-${Date.now()}`);
  try {
    const target = await search.resolve(meta.sample);
    if (!target) throw new Error(`yt-search returned nothing for "${meta.sample}"`);
    const media = await knightbot.fetchVideo(target.url, { tmp, log, quality: 480, maxSizeMB: meta.limits.maxSizeMB });
    const bytes = fs.statSync(media.file).size;
    if (!bytes) throw new Error('downloaded file is empty');
    return `${target.title.slice(0, 36)} · 480p · ${(bytes / 1024 / 1024).toFixed(1)} MB · ${Date.now() - started}ms`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => {
      // yt-search embeds a multi-line request dump in its error message. Keep
      // the first line plus the error code: that is the diagnostic part.
      const first = String(e.message || e).split('\n')[0].trim();
      console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${first}`);
      process.exit(1);
    });
}
module.exports = { check };
