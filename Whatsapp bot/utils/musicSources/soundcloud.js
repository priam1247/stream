'use strict';

/**
 * SoundCloud's own public web API — keyless metadata and direct links.
 *
 * api-v2.soundcloud.com needs a `client_id` that ships in the site's public JS
 * bundles; it is scraped once and cached (the same trick yt-dlp uses). If the
 * scrape or the API fails, callers fall back to yt-dlp, which reads the public
 * SoundCloud page directly.
 */

const C = require('./constants');
const http = require('./http');
const { clean, num, makeTrack, makeResult, makeCollection } = require('./model');

const SOUNDCLOUD_URL_RE = /https?:\/\/(?:www\.|m\.|on\.)?soundcloud\.com\/[^\s"'<>]+/i;

const parseUrl = (text) => {
  const m = String(text || '').match(SOUNDCLOUD_URL_RE);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
};
const isSoundCloudUrl = (text) => Boolean(parseUrl(text));

let clientId = null;
let clientIdAt = 0;

async function scrapeClientId() {
  const html = await http.getText(C.SOUNDCLOUD_HOME, { headers: { Accept: 'text/html' } });
  const scripts = [...html.matchAll(new RegExp(C.SOUNDCLOUD_SCRIPT_RE.source, 'gi'))].map((m) => m[1]);
  // The id usually sits in one of the last bundles, so walk backwards.
  for (const url of scripts.reverse().slice(0, 12)) {
    try {
      const js = await http.getText(url, { headers: { Accept: '*/*' }, maxBytes: 8 * 1024 * 1024 });
      const match = js.match(C.SOUNDCLOUD_CLIENT_ID_RE);
      if (match) return match[1];
    } catch { /* try the previous bundle */ }
  }
  throw new http.MusicSourceError('NO_CLIENT_ID', 'SoundCloud client id not found', 'soundcloud');
}

async function getClientId(force = false) {
  if (!force && clientId && Date.now() - clientIdAt < C.SOUNDCLOUD_CLIENT_ID_TTL_MS) return clientId;
  clientId = await scrapeClientId();
  clientIdAt = Date.now();
  return clientId;
}

async function api(path, params = {}, { retry = true } = {}) {
  const id = await getClientId(!retry);
  try {
    return await http.getJson(`${C.SOUNDCLOUD_API}${path}`, {
      params: { ...params, client_id: id },
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (retry && ['HTTP_401', 'HTTP_403'].includes(err.code)) return api(path, params, { retry: false });
    throw err;
  }
}

const artworkOf = (item) => clean(item?.artwork_url || item?.user?.avatar_url).replace(/-large\./, '-t500x500.');

function trackFromApi(item) {
  return makeTrack({
    id: item?.id,
    title: item?.title,
    artists: [item?.user?.username || item?.publisher_metadata?.artist],
    album: item?.publisher_metadata?.album_title || '',
    durationMs: num(item?.duration),
    cover: artworkOf(item),
    source: 'soundcloud',
    url: item?.permalink_url || '',
  });
}

/** Skip subscription-only ("Go") rows: there is no public audio for them. */
const isPlayable = (item) => item && item.policy !== 'BLOCK'
  && item.monetization_model !== 'SUBSCRIPTION'
  && item.streamable !== false;

async function search(query, { limit = 8 } = {}) {
  const q = clean(query);
  if (!q) return [];
  const want = Math.max(1, Math.min(limit, 20));
  const jobs = [
    { path: '/search/tracks', kind: 'track' },
    { path: '/search/albums', kind: 'album' },
    { path: '/search/playlists_without_albums', kind: 'playlist' },
  ];
  const settled = await Promise.allSettled(jobs.map(async (job) => {
    const data = await http.withTimeout(api(job.path, { q, limit: want }), C.REQUEST_TIMEOUT_MS, {});
    const rows = Array.isArray(data?.collection) ? data.collection : [];
    return rows.filter(isPlayable).slice(0, want).map((item) => makeResult({
      source: 'soundcloud', kind: job.kind, name: item.title,
      subtitle: item.user?.username || '', cover: artworkOf(item),
      url: item.permalink_url || '',
      durationMs: job.kind === 'track' ? num(item.duration) : 0,
    }));
  }));
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

async function resolve(text) {
  const url = parseUrl(text);
  if (!url) throw new http.MusicSourceError('BAD_URL', 'Not a SoundCloud link', 'soundcloud');
  const data = await api('/resolve', { url });
  if (!data || data.errors) throw new http.MusicSourceError('NOT_FOUND', 'SoundCloud could not resolve that link', 'soundcloud');

  if (data.kind === 'track') {
    if (!isPlayable(data)) throw new http.MusicSourceError('NOT_FOUND', 'That track is subscription-only', 'soundcloud');
    const track = trackFromApi(data);
    return makeCollection({
      source: 'soundcloud', kind: 'track', name: track.title, owner: track.artists.join(', '),
      cover: track.cover, url, tracks: [track],
    });
  }

  const stubs = Array.isArray(data.tracks) ? data.tracks : [];
  const tracks = [];
  for (const stub of stubs.slice(0, C.MAX_COLLECTION_TRACKS)) {
    const item = stub?.id && stub?.title && stub?.duration ? stub : null;
    if (item && isPlayable(item)) tracks.push(trackFromApi(item));
  }
  return makeCollection({
    source: 'soundcloud', kind: data.kind === 'album' ? 'album' : 'playlist',
    name: clean(data.title), owner: data.user?.username || '',
    cover: artworkOf(data), url, tracks,
  });
}

module.exports = { isSoundCloudUrl, parseUrl, search, resolve, getClientId, _resetForTests: () => { clientId = null; clientIdAt = 0; } };
