'use strict';

/**
 * Public constants for the standalone media engine.
 *
 * Everything here is a public endpoint, client identifier or limit. There are
 * NO accounts, API keys (beyond YouTube's own public web-client key baked into
 * every youtube.com page), cookies, tokens or CDM values. Optional operator
 * supplied po/visitor tokens are read from the environment, never hard-coded.
 *
 * This engine deliberately does not use yt-dlp, youtubei.js, Hector, yt1d or
 * cobalt. It talks to YouTube's public player endpoint directly and downloads
 * the resulting stream with plain HTTP + the ffmpeg binary already shipped by
 * @ffmpeg-installer/ffmpeg.
 */

module.exports = Object.freeze({
  // YouTube's public Innertube key, embedded in its own web player JS.
  YT_API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  YT_PLAYER: 'https://www.youtube.com/youtubei/v1/player',
  YT_SEARCH: 'https://www.youtube.com/youtubei/v1/search',
  YT_ORIGIN: 'https://www.youtube.com',
  YT_WATCH: 'https://www.youtube.com/watch?v=',

  UA_DESKTOP: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  UA_ANDROID: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11; en_US) gzip',
  UA_IOS: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X; en_US)',
  UA_TV: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',

  /**
   * Client matrix. Each client is tried in order until one returns a playable
   * response with a directly downloadable URL. These are the same public
   * client identifiers yt-dlp and the YouTube web player send; none require a
   * login. Embedded clients carry thirdParty.embedUrl, which is what makes
   * them work on datacenter IPs where standalone clients see LOGIN_REQUIRED.
   */
  CLIENTS: Object.freeze([
    Object.freeze({
      id: 'TV_EMBEDDED', nameId: 85,
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
      clientScreen: 'EMBED', embedded: true,
    }),
    Object.freeze({
      id: 'WEB_EMBEDDED', nameId: 56,
      clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      clientScreen: 'EMBED', embedded: true,
    }),
    Object.freeze({
      id: 'ANDROID', nameId: 3,
      clientName: 'ANDROID', clientVersion: '19.44.38',
      userAgent: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11; en_US) gzip',
      androidSdkVersion: 30,
    }),
    Object.freeze({
      id: 'ANDROID_VR', nameId: 28,
      clientName: 'ANDROID_VR', clientVersion: '1.57.29',
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12; en_US; Quest 3) gzip',
      androidSdkVersion: 32, deviceMake: 'Oculus', deviceModel: 'Quest 3',
    }),
    Object.freeze({
      id: 'IOS', nameId: 5,
      clientName: 'IOS', clientVersion: '19.45.4',
      userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X; en_US)',
      deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.1.22D72',
    }),
    Object.freeze({
      id: 'MWEB', nameId: 2,
      clientName: 'MWEB', clientVersion: '2.20250311.03.00',
      userAgent: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    }),
    Object.freeze({
      id: 'WEB', nameId: 1,
      clientName: 'WEB', clientVersion: '2.20250312.04.00',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    }),
    Object.freeze({
      id: 'TVHTML5', nameId: 7,
      clientName: 'TVHTML5', clientVersion: '7.20250312.18.00',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    }),
  ]),

  // Optional operator-supplied values; never hard-coded. Only sent when set.
  PO_TOKEN: String(process.env.YT_PO_TOKEN || '').trim(),
  VISITOR_DATA: String(process.env.YT_VISITOR_DATA || '').trim(),

  // Progressive itags carry both audio and video in one file (no mux needed).
  PROGRESSIVE_ITAGS: Object.freeze([18, 22, 37, 38, 43, 44]),
  AUDIO_ITAG_PRIORITY: Object.freeze([141, 251, 140, 250, 139, 249]),

  // Host suffixes allowed for stream downloads. A chat message can never make
  // the bot fetch an arbitrary internal host.
  STREAM_HOSTS: Object.freeze([
    'youtube.com', 'googlevideo.com', 'ytimg.com', 'googleapis.com',
    'soundcloud.com', 'sndcdn.com', 'api-v2.soundcloud.com',
  ]),

  SOUNDCLOUD_API: 'https://api-v2.soundcloud.com',
  SOUNDCLOUD_HOME: 'https://soundcloud.com/',

  REQUEST_TIMEOUT_MS: Number(process.env.OWN_MEDIA_TIMEOUT_MS) || 20000,
  DOWNLOAD_TIMEOUT_MS: Number(process.env.OWN_MEDIA_DOWNLOAD_TIMEOUT_MS) || 180000,
  CLIENT_TOTAL_TIMEOUT_MS: Number(process.env.OWN_MEDIA_CLIENT_TIMEOUT_MS) || 90000,
  FFMPEG_TIMEOUT_MS: Number(process.env.OWN_MEDIA_FFMPEG_TIMEOUT_MS) || 300000,
  MAX_AUDIO_MB: Number(process.env.OWN_MEDIA_MAX_AUDIO_MB) || 120,
  MAX_VIDEO_MB: Number(process.env.OWN_MEDIA_MAX_VIDEO_MB) || 300,
  MAX_DIRECT_FORMATS: 12,
  MAX_CLIENTS_PER_REQUEST: 8,
});
