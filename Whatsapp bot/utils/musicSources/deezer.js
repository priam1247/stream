'use strict';

/**
 * Deezer's public JSON API — keyless catalog metadata and link resolution.
 * https://api.deezer.com needs no account; it powers search and pasted
 * track/album/playlist links. The audio itself is never taken from Deezer.
 */

const C = require('./constants');
const http = require('./http');
const { clean, num, makeTrack, makeResult, makeCollection } = require('./model');

function parseUrl(text) {
  const m = String(text || '').match(C.DEEZER_URL_RE);
  return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
}
const isDeezerUrl = (text) => Boolean(parseUrl(text));

async function api(path, params = {}) {
  const data = await http.getJson(`${C.DEEZER_API}${path}`, { params });
  if (data && data.error) throw new http.MusicSourceError('PROVIDER_ERROR', `Deezer: ${clean(data.error.message)}`, 'deezer');
  return data || {};
}

/** Deezer pages collections with an absolute `next` URL. Bound the walk. */
async function followPages(firstPage, cap = C.MAX_COLLECTION_TRACKS) {
  const items = Array.isArray(firstPage?.data) ? [...firstPage.data] : [];
  const seen = new Set();
  let next = firstPage?.next || '';
  let pages = 0;
  while (next && items.length < cap && pages < C.MAX_PAGES) {
    if (seen.has(next)) break;
    seen.add(next);
    let page;
    try { page = await http.getJson(next); }
    catch { break; }
    const batch = Array.isArray(page?.data) ? page.data : [];
    if (!batch.length) break;
    items.push(...batch);
    next = page?.next || '';
    pages++;
  }
  return items.slice(0, cap);
}

function trackFromApi(item, { albumName = '', cover = '', sourceUrl = '' } = {}) {
  const album = item?.album || {};
  return makeTrack({
    id: item?.id,
    title: item?.title,
    artists: [item?.artist?.name],
    album: album.title || albumName,
    durationMs: num(item?.duration) * 1000,
    cover: album.cover_big || album.cover_medium || cover,
    trackNumber: item?.track_position,
    releaseDate: item?.release_date || '',
    previewUrl: item?.preview || '',
    source: 'deezer',
    url: item?.link || (item?.id ? `https://www.deezer.com/track/${item.id}` : sourceUrl),
  });
}

function trackResult(item) {
  return makeResult({
    source: 'deezer', kind: 'track', name: item?.title,
    subtitle: item?.artist?.name, cover: item?.album?.cover_medium,
    url: item?.link || (item?.id ? `https://www.deezer.com/track/${item.id}` : ''),
    durationMs: num(item?.duration) * 1000,
  });
}

function albumResult(item) {
  const artist = item?.artist?.name || '';
  const year = clean(item?.release_date).slice(0, 4);
  const type = clean(item?.record_type).toUpperCase();
  return makeResult({
    source: 'deezer', kind: 'album', name: item?.title,
    subtitle: [artist, year, type && type !== 'ALBUM' ? type : ''].filter(Boolean).join(' · '),
    cover: item?.cover_medium,
    url: item?.link || (item?.id ? `https://www.deezer.com/album/${item.id}` : ''),
  });
}

function artistResult(item) {
  return makeResult({
    source: 'deezer', kind: 'artist', name: item?.name,
    subtitle: item?.nb_album ? `${item.nb_album} releases` : 'Artist',
    cover: item?.picture_medium,
    url: item?.link || (item?.id ? `https://www.deezer.com/artist/${item.id}` : ''),
  });
}

function playlistResult(item) {
  return makeResult({
    source: 'deezer', kind: 'playlist', name: item?.title,
    subtitle: [item?.user?.name ? `by ${item.user.name}` : '', item?.nb_tracks ? `${item.nb_tracks} tracks` : ''].filter(Boolean).join(' · '),
    cover: item?.picture_medium,
    url: item?.link || (item?.id ? `https://www.deezer.com/playlist/${item.id}` : ''),
  });
}

/** Four parallel sub-searches; a slow/broken one never blocks the others. */
async function search(query, { limit = 8 } = {}) {
  const q = clean(query);
  if (!q) return [];
  const quota = (kind) => Math.max(1, Math.min(limit, C.DEEZER_PAGE_QUOTA[kind]));
  const jobs = [
    ['/search/track', 'track', trackResult, quota('track')],
    ['/search/album', 'album', albumResult, quota('album')],
    ['/search/artist', 'artist', artistResult, quota('artist')],
    ['/search/playlist', 'playlist', playlistResult, quota('playlist')],
  ];
  const settled = await Promise.allSettled(jobs.map(async ([path, kind, mapper, n]) => {
    const data = await http.withTimeout(
      api(path, { q, limit: n }),
      C.REQUEST_TIMEOUT_MS, { data: [] },
    );
    return (Array.isArray(data?.data) ? data.data : []).slice(0, limit).map(mapper);
  }));
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/** Pasted Deezer link → a normalized collection of tracks. */
async function resolve(text) {
  const parsed = parseUrl(text);
  if (!parsed) throw new http.MusicSourceError('BAD_URL', 'Not a Deezer link', 'deezer');
  const { kind, id } = parsed;
  const canonical = `https://www.deezer.com/${kind}/${id}`;

  if (kind === 'track') {
    const item = await api(`/track/${id}`);
    const track = trackFromApi(item, { sourceUrl: canonical });
    return makeCollection({
      source: 'deezer', kind: 'track', name: track.title, owner: track.artists.join(', '),
      cover: track.cover, url: canonical, tracks: [track],
    });
  }

  if (kind === 'album') {
    const album = await api(`/album/${id}`);
    const cover = album.cover_big || '';
    const name = clean(album.title);
    const year = clean(album.release_date).slice(0, 4);
    const owner = album.artist?.name || '';
    const items = await followPages(album.tracks || {});
    const tracks = items.map((item, i) => {
      const t = trackFromApi(item, { albumName: name, cover, sourceUrl: canonical });
      return { ...t, trackNumber: t.trackNumber || i + 1, releaseDate: t.releaseDate || year };
    });
    return makeCollection({ source: 'deezer', kind: 'album', name, owner, cover, url: canonical, tracks });
  }

  const playlist = await api(`/playlist/${id}`);
  const cover = playlist.picture_big || '';
  const items = await followPages(playlist.tracks || {});
  return makeCollection({
    source: 'deezer', kind: 'playlist', name: clean(playlist.title),
    owner: playlist.creator?.name || '', cover, url: canonical,
    tracks: items.map((item) => trackFromApi(item, { cover, sourceUrl: canonical })),
  });
}

module.exports = { isDeezerUrl, parseUrl, search, resolve, trackFromApi };
