'use strict';

/**
 * YouTube Music link normalisation.
 *
 * A `music.youtube.com/watch?v=<id>` link is the same public video as
 * `youtube.com/watch?v=<id>`; a `?list=` link is a public playlist. Album and
 * artist `browse/…` pages carry no playable video id, so they are rejected
 * rather than sent to yt-dlp as an unsupported URL.
 */

const C = require('./constants');

const isYouTubeMusicUrl = (text) => C.YTMUSIC_URL_RE.test(String(text || '').trim());

function normalize(text) {
  const raw = String(text || '').trim();
  if (!isYouTubeMusicUrl(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const video = url.searchParams.get('v');
  if (video && /^[-_0-9A-Za-z]{11}$/.test(video)) {
    return `https://www.youtube.com/watch?v=${video}`;
  }
  const list = url.searchParams.get('list');
  if (list && /^[\w-]{8,64}$/.test(list)) {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  }
  return null;
}

module.exports = { isYouTubeMusicUrl, normalize };
