'use strict';

/**
 * Brick 3 — format selection.
 *
 * A progressive mp4 already contains both tracks, so it is the cheapest path.
 * Otherwise pick a direct audio or video stream and let ffmpeg do the work.
 * Ciphered formats are skipped: without a decipherer they cannot be fetched.
 */

const C = require('./constants');

const byBitrate = (a, b) => b.bitrate - a.bitrate;
const byHeight = (wanted) => (a, b) => {
  const da = Math.abs((a.height || 0) - wanted);
  const db = Math.abs((b.height || 0) - wanted);
  return da - db || b.height - a.height || b.bitrate - a.bitrate;
};

const direct = (result) => (result?.formats || []).filter((f) => f.downloadable);
const isMp4 = (f) => /mp4|isom|avc/i.test(f.mime) || C.PROGRESSIVE_ITAGS.includes(f.itag);

function chooseAudio(result) {
  const formats = direct(result);
  const audioOnly = formats.filter((f) => f.hasAudio && !f.hasVideo && /^audio\//.test(f.mime))
    .sort(byBitrate);
  if (audioOnly.length) {
    const best = audioOnly[0];
    return {
      mode: 'direct', url: best.url, mime: best.mime, itag: best.itag,
      label: `audio itag ${best.itag}`, needsAudioExtract: false,
    };
  }
  const progressive = formats.filter((f) => f.hasVideo && f.hasAudio).sort(byBitrate);
  if (progressive.length) {
    const best = progressive[0];
    return {
      mode: 'direct', url: best.url, mime: best.mime, itag: best.itag,
      label: `progressive itag ${best.itag} (ffmpeg extracts audio)`, needsAudioExtract: true,
    };
  }
  if (result?.hlsManifestUrl) {
    return {
      mode: 'ffmpeg-hls', url: result.hlsManifestUrl, mime: 'application/x-mpegURL',
      label: 'HLS manifest', needsAudioExtract: true,
    };
  }
  if (result?.dashManifestUrl) {
    return {
      mode: 'ffmpeg-dash', url: result.dashManifestUrl, mime: 'application/dash+xml',
      label: 'DASH manifest', needsAudioExtract: true,
    };
  }
  return null;
}

function chooseVideo(result, height = 720) {
  const wanted = Number(height) || 720;
  const formats = direct(result);
  const progressive = formats
    .filter((f) => f.hasVideo && f.hasAudio && isMp4(f))
    .sort(byHeight(wanted));
  if (progressive.length) {
    const best = progressive[0];
    return {
      mode: 'direct', url: best.url, mime: best.mime, itag: best.itag,
      label: `progressive ${best.qualityLabel || `${best.height}p`} (itag ${best.itag})`,
      needsMux: false,
    };
  }
  const video = formats.filter((f) => f.hasVideo && !f.hasAudio).sort(byHeight(wanted))[0];
  const audio = formats.filter((f) => f.hasAudio && !f.hasVideo && /^audio\//.test(f.mime))
    .sort(byBitrate)[0];
  if (video && audio) {
    return {
      mode: 'ffmpeg-mux', url: video.url, audioUrl: audio.url,
      mime: 'video/mp4', label: `${video.qualityLabel || `${video.height}p`} + audio (mux)`,
      needsMux: true,
    };
  }
  if (result?.hlsManifestUrl) {
    return {
      mode: 'ffmpeg-hls', url: result.hlsManifestUrl, mime: 'application/x-mpegURL',
      label: 'HLS manifest (ffmpeg remux)', needsMux: true,
    };
  }
  if (result?.dashManifestUrl) {
    return {
      mode: 'ffmpeg-dash', url: result.dashManifestUrl, mime: 'application/dash+xml',
      label: 'DASH manifest (ffmpeg remux)', needsMux: true,
    };
  }
  return null;
}

function choose(result, kind, height) {
  return kind === 'audio'
    ? chooseAudio(result)
    : chooseVideo(result, height);
}

module.exports = { choose, chooseAudio, chooseVideo, byBitrate, byHeight, isMp4 };
