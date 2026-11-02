'use strict';

/**
 * commands/song/search.js — turn "a song name" or "a URL" into one YouTube URL.
 *
 * One path only: yt-search. The old code additionally had extractYouTubeId,
 * canonicalYouTubeUrl, and a separate Innertube search; those are gone.
 */

const yts = require('yt-search');

const YT_ID = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function youtubeId(input) {
  const text = String(input || '').trim();
  const match = YT_ID.exec(text);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  return null;
}

function canonical(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * @param {string} input  free text or a YouTube URL
 * @returns {Promise<{url:string, title:string, durationSeconds:number}|null>}
 */
async function resolve(input) {
  const id = youtubeId(input);
  if (id) {
    // A direct link needs no search, but we still ask yt-search for metadata so
    // the duration limit can be enforced before downloading.
    const found = await yts({ videoId: id });
    const video = Array.isArray(found?.videos) ? found.videos[0] : found;
    return {
      url: canonical(id),
      title: video?.title || 'audio',
      durationSeconds: Number(video?.seconds) || 0,
    };
  }

  const results = await yts(String(input));
  const first = Array.isArray(results?.videos) ? results.videos[0] : null;
  if (!first || !first.videoId) return null;

  return {
    url: canonical(first.videoId),
    title: first.title || 'audio',
    durationSeconds: Number(first.seconds) || 0,
  };
}

module.exports = { resolve, youtubeId, canonical };
