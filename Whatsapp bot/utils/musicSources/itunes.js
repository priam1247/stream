'use strict';

/**
 * iTunes Search / Lookup — keyless Apple Music metadata.
 *
 * `itunes.apple.com/search` and `/lookup` are the public JSON endpoints the
 * old iTunes client used. They cover songs and albums, which makes pasted
 * music.apple.com links resolvable without an Apple developer token.
 */

const C = require('./constants');
const http = require('./http');
const { clean, num, makeTrack, makeResult, makeCollection } = require('./model');

function parseUrl(text) {
  const m = String(text || '').match(C.ITUNES_URL_RE);
  if (!m) return null;
  let kind = m[1].toLowerCase();
  let id = m[2];
  // An album URL with ?i=<trackId> points at one song on that album.
  try {
    const url = new URL(String(text).startsWith('http') ? text : `https://${text}`);
    const songId = url.searchParams.get('i');
    if (kind === 'album' && /^\d+$/.test(songId || '')) { kind = 'song'; id = songId; }
  } catch { /* keep the parsed id */ }
  return { kind, id };
}
const isAppleMusicUrl = (text) => Boolean(parseUrl(text));

async function api(path, params = {}) {
  const data = await http.getJson(`${C.ITUNES_API}${path}`, { params });
  return Array.isArray(data?.results) ? data.results : [];
}

const artwork = (item) => {
  const url = clean(item?.artworkUrl100 || item?.artworkUrl60);
  return url ? url.replace(/100x100|60x60/g, '600x600') : '';
};

function trackFromApi(item) {
  return makeTrack({
    id: item?.trackId || item?.collectionId,
    title: item?.trackName,
    artists: [item?.artistName],
    album: item?.collectionName,
    durationMs: num(item?.trackTimeMillis),
    cover: artwork(item),
    trackNumber: item?.trackNumber,
    releaseDate: item?.releaseDate || '',
    previewUrl: item?.previewUrl || '',
    source: 'itunes',
    url: item?.trackViewUrl || '',
  });
}

/** iTunes has no offset: ask for everything up to the page end and slice. */
async function search(query, { limit = 8 } = {}) {
  const q = clean(query);
  if (!q) return [];
  const want = Math.max(1, Math.min(limit, C.ITUNES_PAGE_QUOTA));
  const jobs = [
    { entity: 'song', kind: 'track', urlKey: 'trackViewUrl', nameKey: 'trackName' },
    { entity: 'album', kind: 'album', urlKey: 'collectionViewUrl', nameKey: 'collectionName' },
  ];
  const settled = await Promise.allSettled(jobs.map(async (job) => {
    const rows = await http.withTimeout(
      api('/search', { term: q, media: 'music', entity: job.entity, limit: Math.min(C.ITUNES_API_MAX, want) }),
      C.REQUEST_TIMEOUT_MS, [],
    );
    return rows.slice(0, want).filter((item) => item[job.urlKey]).map((item) => makeResult({
      source: 'itunes', kind: job.kind, name: item[job.nameKey],
      subtitle: job.kind === 'album'
        ? [item.artistName, clean(item.releaseDate).slice(0, 4)].filter(Boolean).join(' · ')
        : item.artistName,
      cover: artwork(item), url: item[job.urlKey],
      durationMs: job.kind === 'track' ? num(item.trackTimeMillis) : 0,
    }));
  }));
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

async function resolve(text) {
  const parsed = parseUrl(text);
  if (!parsed) throw new http.MusicSourceError('BAD_URL', 'Not an Apple Music link', 'itunes');
  const { kind, id } = parsed;
  const canonical = String(text).match(/^https?:\/\//) ? String(text) : `https://${text}`;

  if (kind === 'song') {
    const items = (await api('/lookup', { id })).filter((i) => i.trackId);
    if (!items.length) throw new http.MusicSourceError('NOT_FOUND', 'iTunes does not know that song', 'itunes');
    const track = trackFromApi(items[0]);
    return makeCollection({
      source: 'itunes', kind: 'track', name: track.title, owner: track.artists.join(', '),
      cover: track.cover, url: canonical, tracks: [track],
    });
  }

  const items = await api('/lookup', { id, entity: 'song', limit: C.ITUNES_API_MAX });
  const album = items.find((i) => i.collectionType) || {};
  const tracks = items.filter((i) => i.wrapperType === 'track').map(trackFromApi);
  if (!tracks.length) throw new http.MusicSourceError('NOT_FOUND', 'iTunes listed no tracks for that album', 'itunes');
  return makeCollection({
    source: 'itunes', kind: 'album', name: clean(album.collectionName) || tracks[0].album,
    owner: album.artistName || '', cover: artwork(album) || tracks[0].cover,
    url: canonical, tracks,
  });
}

module.exports = { isAppleMusicUrl, parseUrl, search, resolve, trackFromApi };
