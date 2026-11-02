'use strict';

/**
 * ZaFar Bot — public constants for the keyless music sources.
 *
 * Everything here is a public endpoint, magic value or limit taken from:
 *   • amiralibg/unstream (MIT) — keyless Deezer / iTunes / Spotify embed /
 *     SoundCloud metadata, duration-matched ytsearch and tagged MP3 flow.
 *   • sonorahq/sonora (GPL-3.0) — the keyless lyrics constants only (Kugou,
 *     Netease, Binimum). No implementation code from that project is copied.
 *
 * There are NO accounts, API keys, ARL cookies, bearer tokens or Widevine CDM
 * values here and none are needed: streaming services are used for metadata
 * only. Audio and music video come from public YouTube / SoundCloud pages via
 * the bot's existing yt-dlp pipeline. No DRM is decrypted.
 */

// config.js loads .env, so every MUSIC_* tuning value below can be overridden
// on hosts that have an env file (and keeps its default on panel-only hosts).
require('../../config');
const pkg = require('../../package.json');

module.exports = Object.freeze({
  // One UA for every catalog request (the Spotify embed page expects a browser).
  UA: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  LYRICS_UA: `zafar/${pkg.version} (+https://github.com/priam1247/stream)`,

  // ── Deezer public API ────────────────────────────────────────────────────
  DEEZER_API: 'https://api.deezer.com',
  DEEZER_PAGE_QUOTA: Object.freeze({ track: 30, album: 20, artist: 12, playlist: 12 }),
  DEEZER_URL_RE: /deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)/i,

  // ── iTunes Search / Lookup (Apple Music links) ───────────────────────────
  ITUNES_API: 'https://itunes.apple.com',
  ITUNES_PAGE_QUOTA: 25,
  ITUNES_API_MAX: 200,
  ITUNES_URL_RE: /music\.apple\.com\/(?:[a-z]{2}\/)?(album|song)\/[^/]+\/(?:id)?(\d+)/i,

  // ── Spotify public embed player ──────────────────────────────────────────
  SPOTIFY_EMBED: 'https://open.spotify.com/embed',
  SPOTIFY_URL_RE: /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)/i,
  SPOTIFY_TOKEN_URLS: Object.freeze([
    'https://open.spotify.com/embed/api/token',
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
  ]),
  SPOTIFY_PATHFINDER: 'https://api-partner.spotify.com/pathfinder/v1/query',
  // The web player's persisted `fetchPlaylistContents` hash. Spotify rotates
  // it; a stale hash just means playlists stay at the embed's first 100 rows.
  SPOTIFY_PLAYLIST_QUERY_HASH: '86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0',
  SPOTIFY_EMBED_CAP: 100,
  SPOTIFY_PAGE: 100,

  // ── SoundCloud public web API (client id scraped from its JS bundles) ─────
  SOUNDCLOUD_HOME: 'https://soundcloud.com/',
  SOUNDCLOUD_API: 'https://api-v2.soundcloud.com',
  SOUNDCLOUD_URL_RE: /(?:www\.|m\.|on\.)?soundcloud\.com\//i,
  SOUNDCLOUD_SCRIPT_RE: /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/gi,
  SOUNDCLOUD_CLIENT_ID_RE: /client_id\s*:\s*"([a-zA-Z0-9]{32})"/,
  SOUNDCLOUD_CLIENT_ID_TTL_MS: 30 * 60 * 1000,

  // ── YouTube Music / direct links ─────────────────────────────────────────
  YTMUSIC_URL_RE: /^https?:\/\/music\.youtube\.com\//i,

  // ── Keyless lyrics catalogs ──────────────────────────────────────────────
  LRCLIB_API: 'https://lrclib.net/api',
  KUGOU_SEARCH: 'https://mobiles.kugou.com/api/v3/search/song',
  KUGOU_CANDIDATES: 'https://lyrics.kugou.com/search',
  KUGOU_DOWNLOAD: 'https://lyrics.kugou.com/download',
  KUGOU_CIPHER: Buffer.from([
    0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
    0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
  ]),
  KUGOU_SONGS: 4,
  KUGOU_PAGE: 20,
  NETEASE_SEARCH: 'https://music.163.com/api/search/get',
  NETEASE_LYRIC: 'https://music.163.com/api/song/lyric/v1',
  NETEASE_REFERER: 'https://music.163.com',
  BINIMUM_BASE: 'https://lyrics-api.binimum.org/',
  BINIMUM_TRUST: 180,

  // ── Search / match behaviour ─────────────────────────────────────────────
  REQUEST_TIMEOUT_MS: Number(process.env.MUSIC_REQUEST_TIMEOUT_MS) || 15_000,
  SEARCH_TIMEOUT_MS: Number(process.env.MUSIC_SEARCH_TIMEOUT_MS) || 20_000,
  TAG_TIMEOUT_MS: Number(process.env.MUSIC_TAG_TIMEOUT_MS) || 4_000,
  MAX_DURATION_DRIFT: Number(process.env.MUSIC_MAX_DURATION_DRIFT) || 20,
  YTSEARCH_COUNT: 8,
  MAX_UPLOAD_SECONDS: 25 * 60,
  MAX_COLLECTION_TRACKS: 200,
  MAX_PAGES: 10,
  MAX_PICKER_ITEMS: 10,
  MAX_COVER_BYTES: 4 * 1024 * 1024,
  MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  SOURCE_WEIGHT: Object.freeze({
    deezer: 1.0, itunes: 0.97, spotify: 0.95, soundcloud: 0.9, youtube: 0.87,
  }),
});
