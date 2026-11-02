'use strict';

/**
 * commands/song/check.js — live self-test against the real ApisSupreme endpoint.
 *
 *   ✅ song — resolved "...": 3.4 MB in 2100ms
 *   ❌ song — ApisSupreme returned HTTP 403
 *
 * It downloads to a temp folder and deletes it. It never sends anything.
 * Run it before blaming the gateway: if this is ❌, .song is ❌ for the same reason.
 *
 * Note: this makes a real network call. In a sandbox with no outbound access it
 * will correctly report ❌ rather than pretending to pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const meta = require('./command.json');
const search = require('./search');
const apisupreme = require('./apisupreme');

const log = { debug() {}, info() {}, warn() {}, error() {} };

async function check() {
  const started = Date.now();
  const tmp = path.join(os.tmpdir(), `check-song-${Date.now()}`);
  try {
    const target = await search.resolve(meta.sample);
    if (!target) throw new Error(`yt-search returned nothing for "${meta.sample}"`);

    const track = await apisupreme.fetchAudio(target.url, { tmp, log, maxSizeMB: meta.limits.maxSizeMB });
    const bytes = fs.statSync(track.file).size;
    if (!bytes) throw new Error('downloaded file is empty');

    return `${target.title.slice(0, 40)} · ${(bytes / 1024 / 1024).toFixed(1)} MB · ${Date.now() - started}ms`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  check()
    .then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => {
      // yt-search embeds a multi-line request dump in its error message. Keep
      // the first line plus the error code: that is the diagnostic part.
      const first = String(e.message || e).split('\n')[0].trim();
      console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${first}`);
      process.exit(1);
    });
}

module.exports = { check };
