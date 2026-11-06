'use strict';

// Shared by .movie and .series so neither command imports the other.
const { probeMedia } = require('../mediaTransfer');

/**
 * Shortest playtime a real copy can have. Fake uploads ("[Hindi] [Full movie]",
 * trailers, 2-minute teasers) are served under the film's own name.
 */
function minPlaySeconds(runtimeMin, kind = 'movie') {
  const rt = Number(runtimeMin) || 0;
  if (kind === 'episode') return rt ? rt * 60 * 0.5 : 5 * 60;
  return Math.max(40 * 60, rt * 60 * 0.6);
}

/** Throw when the downloaded file is a clip, not the title. */
async function assertFullLength(file, runtimeMin, kind = 'movie') {
  const { duration } = await probeMedia(file);
  const min = minPlaySeconds(runtimeMin, kind);
  if (duration && duration < min) {
    throw Object.assign(
      new Error(`only ${Math.max(1, Math.round(duration / 60))} min long — a trailer/fake upload, not the full ${kind}`),
      { code: 'SHORT' },
    );
  }
  return duration;
}

module.exports = { minPlaySeconds, assertFullLength };
