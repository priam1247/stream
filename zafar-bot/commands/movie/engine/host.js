// engine/host.js — no host bridge.
//
// The original engine reached back into the bot with createRequire() to borrow
// utils/movieHost.js (ffmpeg path, N_m3u8DL acceleration). That is a hidden
// dependency from a command towards code outside its folder, which rule 1
// forbids. Every host hook now reports "unavailable", so the engine uses only
// its own in-folder code paths. No fallback chain, nothing reaching outside.
//
// Exports are exactly the three names engine/media/download.js imports.

/** ffmpeg binary the host already verified (null -> engine probes itself). */
export async function ffmpegPath() {
  return null;
}

/**
 * The old host offered an accelerated HLS/DASH path via N_m3u8DL-RE.
 * That accelerator lived outside this command, so it is gone. Returning null
 * tells the engine to use its own downloader; it is not a silent downgrade,
 * it is the only path.
 */
export async function hlsDownload() {
  return null;
}

/**
 * The old host offered a different-site downloader. Removed for the same reason:
 * .movie and .series resolve their own sources or fail loudly.
 */
export async function downloadFallback() {
  return null;
}

export default { ffmpegPath, hlsDownload, downloadFallback };
