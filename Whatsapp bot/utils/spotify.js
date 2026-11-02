/**
 * ZaFar Bot — Spotify metadata (no API key needed)
 *
 * `.spotify <link>` has to answer "what song is this?" before it can download
 * anything. Order of resolution, all keyless by default:
 *
 *   1. public embed / __NEXT_DATA__ (artists, album, cover, duration)
 *   2. Web API, if SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are configured
 *   3. public oEmbed endpoint as a last-resort fallback
 *
 *      GET https://open.spotify.com/oembed?url=<track url>
 *      → { title, author_name, thumbnail_url, ... }
 *
 * The duration lets `.spotify` match the right YouTube upload instead of a
 * live version or an hour-long mix.
 */

const axios = require('axios');
const config = require('../config');
const spotifyEmbed = require('./musicSources/spotifyEmbed');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SPOTIFY_RE = /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)/i;

const parseSpotifyUrl = (text) => {
  const m = String(text || '').match(SPOTIFY_RE);
  return m ? { type: m[1].toLowerCase(), id: m[2], url: `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}` } : null;
};

let _token = null; // { value, expiresAt }

async function clientCredentialsToken() {
  const id = config.spotify?.clientId || process.env.SPOTIFY_CLIENT_ID || '';
  const secret = config.spotify?.clientSecret || process.env.SPOTIFY_CLIENT_SECRET || '';
  if (!id || !secret) return null;
  if (_token && Date.now() < _token.expiresAt) return _token.value;

  const res = await axios.post('https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      },
    });
  const token = res.data?.access_token;
  if (!token) return null;
  _token = { value: token, expiresAt: Date.now() + ((Number(res.data.expires_in) || 3600) - 60) * 1000 };
  return token;
}

/** Metadata via the official Web API (only when credentials exist). */
async function viaWebApi(parsed) {
  const token = await clientCredentialsToken();
  if (!token) return null;

  const res = await axios.get(`https://api.spotify.com/v1/${parsed.type}s/${parsed.id}`, {
    timeout: 15000,
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = res.data || {};
  const artists = Array.isArray(d.artists) ? d.artists.map(a => a.name).join(', ')
    : (d.owner?.display_name || d.show?.publisher || '');
  return {
    title: d.name || '',
    artists,
    album: d.album?.name || d.show?.name || '',
    durationMs: d.duration_ms || 0,
    cover: d.album?.images?.[0]?.url || d.images?.[0]?.url || '',
    source: 'spotify-api',
  };
}

/** Metadata via public oEmbed (no credentials required). */
async function viaOembed(parsed) {
  const res = await axios.get(`https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.url)}`, {
    timeout: 15000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  const d = res.data || {};
  return {
    title: d.title || '',
    // oEmbed puts "Artist" or "Artist · Track" in author_name — keep it whole.
    artists: d.author_name || '',
    album: '',
    durationMs: 0,
    cover: d.thumbnail_url || '',
    source: 'spotify-oembed',
  };
}

/**
 * Keyless metadata from the public embed page. It carries artists, album,
 * cover art and a real duration (which oEmbed does not), so the downloader can
 * match a YouTube upload to the correct recording.
 */
async function viaEmbed(parsed) {
  if (!parsed || !['track', 'album', 'playlist'].includes(parsed.type)) return null;
  try {
    const collection = await spotifyEmbed.resolve(parsed.url);
    const track = collection.tracks?.[0];
    if (!track?.title) return null;
    return {
      title: track.title,
      artists: track.artists.join(', '),
      album: track.album || collection.name,
      durationMs: track.durationMs || 0,
      cover: track.cover || collection.cover || '',
      source: 'spotify-embed',
      collection: { name: collection.name, kind: collection.kind, trackCount: collection.tracks.length },
    };
  } catch (e) {
    console.warn('[spotify] embed metadata failed:', e.message);
    return null;
  }
}

/**
 * Resolve a Spotify link (or a bare "artist - title" query) to search terms.
 * @returns {Promise<{title,artists,album,cover,searchQuery,source}>}
 */
async function resolveTrack(input) {
  const parsed = parseSpotifyUrl(input);
  if (!parsed) {
    const query = String(input || '').trim();
    if (!query) throw new Error('Nothing to look up');
    return { title: query, artists: '', album: '', cover: '', durationMs: 0, searchQuery: query, source: 'query' };
  }

  let meta = await viaEmbed(parsed);
  if (!meta) {
    try { meta = await viaWebApi(parsed); } catch (e) { console.warn('[spotify] web api failed:', e.message); }
  }
  if (!meta) {
    try { meta = await viaOembed(parsed); } catch (e) {
      console.warn('[spotify] oembed failed:', e.message);
      const err = new Error('Spotify did not answer — is the link public?');
      err.code = 'SPOTIFY_META';
      throw err;
    }
  }

  if (!meta.title) {
    const err = new Error('Spotify returned no track metadata');
    err.code = 'SPOTIFY_META';
    throw err;
  }

  // "Artist - Title" is what YouTube matches best.
  const searchQuery = [meta.artists, meta.title].filter(Boolean).join(' - ').trim();
  return { ...meta, searchQuery, type: parsed.type };
}

module.exports = { parseSpotifyUrl, resolveTrack };
