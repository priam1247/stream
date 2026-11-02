'use strict';

/**
 * Spotify metadata without credentials.
 *
 * The public embed widget (open.spotify.com/embed/<kind>/<id>) ships name,
 * artists, cover art and its first 100 track rows as JSON inside
 * <script id="__NEXT_DATA__">. Longer playlists are topped up from the same
 * pathfinder endpoint the web player pages with, using the anonymous token the
 * embed widget itself mints. No app registration, no account, no API key.
 *
 * Undocumented page structure: if Spotify changes it, resolution degrades
 * gracefully (an error is returned instead of a wrong track).
 */

const C = require('./constants');
const http = require('./http');
const { clean, num, makeTrack, makeCollection } = require('./model');

const NEXT_DATA_RE = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

function parseUrl(text) {
  const m = String(text || '').match(C.SPOTIFY_URL_RE);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  if (!['track', 'album', 'playlist'].includes(kind)) return null; // episodes have no embed tracklist
  return { kind, id: m[2] };
}
const isSpotifyUrl = (text) => Boolean(parseUrl(text));

async function fetchEntity(kind, id) {
  const html = await http.getText(`${C.SPOTIFY_EMBED}/${kind}/${id}`, {
    headers: { Accept: 'text/html' },
  });
  const match = html.match(NEXT_DATA_RE);
  if (!match) {
    throw new http.MusicSourceError('LAYOUT_CHANGED', 'Spotify embed layout changed', 'spotify');
  }
  let entity;
  try {
    entity = JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity;
  } catch {
    throw new http.MusicSourceError('BAD_JSON', 'Spotify embed data was unreadable', 'spotify');
  }
  if (!entity) throw new http.MusicSourceError('NOT_FOUND', 'Spotify embed has no metadata', 'spotify');
  return entity;
}

function coverOf(entity) {
  const sources = entity?.coverArt?.sources || [];
  if (sources.length) {
    return sources.reduce((best, s) => (num(s.width) > num(best?.width) ? s : best), sources[0])?.url || '';
  }
  const images = entity?.visualIdentity?.image || [];
  if (images.length) {
    return images.reduce((best, s) => (num(s.maxWidth) > num(best?.maxWidth) ? s : best), images[0])?.url || '';
  }
  return '';
}

const idFromUri = (uri) => String(uri || '').split(':').pop();
const yearOf = (entity) => clean(entity?.releaseDate?.isoString).slice(0, 4);
const previewOf = (entity) => clean(entity?.audioPreview?.url) || null;

function trackFromList(item, position, { albumName = '', cover = '', year = '', owner = '' } = {}) {
  const artists = clean(item?.subtitle).split(',').map((a) => a.trim()).filter(Boolean);
  return makeTrack({
    id: idFromUri(item?.uri) || `pos${position}`,
    title: item?.title,
    artists: artists.length ? artists : (owner ? [owner] : []),
    album: albumName,
    durationMs: num(item?.duration),
    cover,
    trackNumber: position,
    releaseDate: year,
    previewUrl: previewOf(item),
    source: 'spotify',
  });
}

async function anonymousToken() {
  for (const url of C.SPOTIFY_TOKEN_URLS) {
    try {
      const data = await http.getJson(url, { headers: { Accept: 'application/json' } });
      if (clean(data?.accessToken)) return clean(data.accessToken);
    } catch { /* try the next token endpoint */ }
  }
  throw new http.MusicSourceError('NO_TOKEN', 'Spotify would not issue an anonymous token', 'spotify');
}

async function playlistPage(id, token, offset) {
  const data = await http.getJson(C.SPOTIFY_PATHFINDER, {
    params: {
      operationName: 'fetchPlaylistContents',
      variables: JSON.stringify({
        uri: `spotify:playlist:${id}`,
        offset,
        limit: C.SPOTIFY_PAGE,
        enableWatchFeedEntrypoint: false,
        includeEpisodeContentRatingsV2: false,
      }),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: C.SPOTIFY_PLAYLIST_QUERY_HASH },
      }),
    },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (data?.errors) throw new http.MusicSourceError('PROVIDER_ERROR', 'Spotify rejected the playlist query', 'spotify');
  const content = data?.data?.playlistV2?.content;
  if (!content) throw new http.MusicSourceError('BAD_JSON', 'Unexpected playlist response', 'spotify');
  return content;
}

function apiTrack(item, position) {
  const wrapper = item?.itemV2 || {};
  if (wrapper.__typename !== 'TrackResponseWrapper') return null;
  const data = wrapper.data || {};
  const album = data.albumOfTrack || {};
  const sources = album.coverArt?.sources || [];
  const cover = sources.length
    ? sources.reduce((best, s) => (num(s.width) > num(best?.width) ? s : best), sources[0])?.url || ''
    : '';
  const artists = (data.artists?.items || []).map((a) => clean(a?.profile?.name)).filter(Boolean);
  return makeTrack({
    id: idFromUri(data.uri) || `pos${position}`,
    title: data.name,
    artists,
    album: album.name,
    durationMs: num(data.trackDuration?.totalMilliseconds),
    cover,
    trackNumber: position,
    releaseDate: clean(album.date?.isoString).slice(0, 4),
    source: 'spotify',
  });
}

/** Best-effort tail of playlists longer than the embed's 100-row cap. */
async function extendPlaylist(tracks, id) {
  if (tracks.length < C.SPOTIFY_EMBED_CAP) return tracks;
  try {
    const token = await anonymousToken();
    const extra = [];
    let offset = C.SPOTIFY_EMBED_CAP;
    for (let page = 0; page < C.MAX_PAGES && extra.length + tracks.length < C.MAX_COLLECTION_TRACKS; page++) {
      const content = await playlistPage(id, token, offset);
      const batch = Array.isArray(content.items) ? content.items : [];
      for (const item of batch) {
        const track = apiTrack(item, tracks.length + extra.length + 1);
        if (track) extra.push(track);
      }
      const total = num(content.totalCount);
      if (!batch.length || offset + batch.length >= total) break;
      offset += batch.length;
    }
    return tracks.concat(extra);
  } catch {
    return tracks; // an unreachable API must not fail an already resolved link
  }
}

async function resolve(text) {
  const parsed = parseUrl(text);
  if (!parsed) throw new http.MusicSourceError('BAD_URL', 'Not a Spotify link', 'spotify');
  const { kind, id } = parsed;
  const canonical = `https://open.spotify.com/${kind}/${id}`;
  const entity = await fetchEntity(kind, id);
  const name = clean(entity.name || entity.title) || 'Unknown';
  const cover = coverOf(entity);

  if (kind === 'track') {
    const artists = (entity.artists || []).map((a) => clean(a?.name)).filter(Boolean);
    const track = makeTrack({
      id, title: name, artists: artists.length ? artists : ['Unknown artist'],
      album: entity.albumOfTrack?.name, durationMs: num(entity.duration), cover,
      releaseDate: yearOf(entity), previewUrl: previewOf(entity), source: 'spotify', url: canonical,
    });
    return makeCollection({
      source: 'spotify', kind: 'track', name: track.title, owner: track.artists.join(', '),
      cover, url: canonical, tracks: [track],
    });
  }

  const rows = Array.isArray(entity.trackList) ? entity.trackList : [];
  if (!rows.length) throw new http.MusicSourceError('NOT_FOUND', `The ${kind} embed listed no tracks`, 'spotify');
  const year = yearOf(entity);
  const owner = clean(entity.subtitle) || (entity.artists || []).map((a) => clean(a?.name)).filter(Boolean).join(', ');

  if (kind === 'album') {
    return makeCollection({
      source: 'spotify', kind: 'album', name, owner, cover, url: canonical,
      tracks: rows.map((item, i) => trackFromList(item, i + 1, { albumName: name, cover, year, owner })),
    });
  }

  const tracks = rows.map((item, i) => trackFromList(item, i + 1, { cover }));
  return makeCollection({
    source: 'spotify', kind: 'playlist', name, owner, cover, url: canonical,
    tracks: await extendPlaylist(tracks, id),
  });
}

module.exports = { isSpotifyUrl, parseUrl, resolve, fetchEntity, extendPlaylist };
