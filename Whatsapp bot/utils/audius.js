/**
 * Public Audius search and creator-permitted downloads.
 * API reference: https://docs.audius.co/api
 * Never use a stream URL to work around a disabled or gated download.
 */
const { publicGet, credentialHeaders } = require('./publicHttp');
const { downloadPublicFile } = require('./publicMediaDownload');

const API = 'https://api.audius.co/v1';
const APP = 'zafar-bot';
const MAX_QUERY = 200;
const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = (id) => /^[a-z0-9]{1,20}$/i.test(String(id || ''));
const cleanText = (value, max = 140) => String(value || '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, max);

/** Search filters have returned gated/non-downloadable tracks in practice. */
function permittedTrack(track) {
  if (!track || !validId(track.id) || track.is_downloadable !== true ||
      track.is_download_gated !== false || track.access?.download !== true ||
      track.download_conditions != null || track.is_available === false ||
      track.is_delete === true || track.is_unlisted === true) return null;
  const title = cleanText(track.title);
  const artist = cleanText(track.user?.name || track.user?.handle);
  const duration = Number(track.duration);
  if (!title || !artist || !Number.isFinite(duration) || duration <= 0) return null;
  return { id: String(track.id), title, artist, duration: Math.round(duration) };
}

function createClient({ get = publicGet, download = downloadPublicFile } = {}) {
  async function json(url, params = {}) {
    try {
      const response = await get(url, {
        params: { app_name: APP, ...params }, timeout: 15000,
        maxRedirects: 0, maxContentLength: 4 * 1024 * 1024, proxy: false, auth: null,
        headers: { 'User-Agent': 'ZaFarBot/2.2 public music search', Accept: 'application/json', ...credentialHeaders },
      });
      if (!response?.data || typeof response.data !== 'object') throw new Error('Invalid response');
      return response.data;
    } catch {
      throw fail('AUDIUS_NETWORK', 'Audius search is temporarily unavailable');
    }
  }

  async function search(query, { limit = 5 } = {}) {
    const text = cleanText(query, MAX_QUERY + 1);
    if (!text || text.length > MAX_QUERY) throw fail('AUDIUS_QUERY', 'Invalid search title');
    const count = Math.min(10, Math.max(1, Math.floor(Number(limit) || 5)));
    const data = await json(`${API}/tracks/search`, {
      query: text, only_downloadable: 1, limit: Math.min(100, Math.max(30, count * 5)),
    });
    if (!Array.isArray(data.data)) throw fail('AUDIUS_NETWORK', 'Audius search returned an invalid response');
    const seen = new Set();
    const tracks = [];
    for (const raw of data.data) {
      const track = permittedTrack(raw);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
      if (tracks.length >= count) break;
    }
    return tracks;
  }

  async function downloadTrack(id, dest, { maxBytes, maxSeconds = 10800, timeoutMs } = {}) {
    if (!validId(id)) throw fail('MEDIA_UNAVAILABLE', 'Invalid Audius track');
    const data = await json(`${API}/tracks/${id}`);
    const track = permittedTrack(data.data);
    if (!track || track.id !== String(id)) throw fail('MEDIA_UNAVAILABLE', 'This Audius download is no longer available');
    if (track.duration > maxSeconds) throw fail('TOO_LONG', 'Audio exceeds the duration limit');
    const result = await download(`${API}/tracks/${id}/download?app_name=${APP}`, dest, { maxBytes, timeoutMs });
    return { ...track, bytes: result.bytes };
  }

  return { search, downloadTrack };
}

module.exports = { API, MAX_QUERY, validId, permittedTrack, createClient };
