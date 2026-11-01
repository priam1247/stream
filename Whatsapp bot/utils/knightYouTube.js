/**
 * Public YouTube resolver used by KnightBot-Mini. This is independently
 * implemented from its public HTTP response shape; no upstream API keys or
 * account credentials are used. The returned URL still has to be downloaded
 * and checked before it can be considered a success.
 */
const { createPublicHttp } = require('./publicHttp');
const { safeUrl } = require('./publicMediaDownload');
const YT = require('./youtubedl');

const ENDPOINT = 'https://yt-dl.officialhectormanuel.workers.dev';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const fail = (code, message) => Object.assign(new Error(message), { code });

function usableUrl(value) {
  try {
    const url = safeUrl(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // These URLs are generally bound to the resolver's IP, not the bot's.
    if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com') ||
        ((host === 'youtube.com' || host.endsWith('.youtube.com')) && url.pathname === '/videoplayback')) return null;
    return url.href;
  } catch { return null; }
}

function selectVideo(videos, requested) {
  if (!videos || typeof videos !== 'object' || Array.isArray(videos)) return null;
  const wanted = Number.parseInt(requested, 10) || 720;
  const qualities = [144, 240, 360, 480, 720, 1080];
  // Prefer the requested resolution, then the closest lower one, then higher.
  const sorted = [...qualities.filter((q) => q <= wanted).reverse(), ...qualities.filter((q) => q > wanted)];
  for (const quality of sorted) {
    const url = usableUrl(videos[String(quality)] || videos[`${quality}p`]);
    if (url) return { url, quality };
  }
  return null;
}

function createClient({ http = createPublicHttp() } = {}) {
  return {
    async resolve(input, { kind = 'audio', quality = 720, timeoutMs = 45000 } = {}) {
      const id = YT.isYouTubeUrl(input) ? YT.extractVideoId(input) : null;
      if (!id || !['audio', 'video'].includes(kind)) throw fail('UNSUPPORTED_URL', 'A YouTube video link is required');
      let response;
      try {
        response = await http.get(ENDPOINT, {
          params: { url: `https://www.youtube.com/watch?v=${id}` },
          timeout: Math.max(1000, Math.min(Number(timeoutMs) || 45000, 90000)),
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
          headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: undefined, Cookie: undefined, 'Proxy-Authorization': undefined },
          validateStatus: () => true,
        });
      } catch (error) {
        const code = /^(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED|ECONNRESET|ECONNREFUSED)$/.test(error?.code) ? error.code : 'NETWORK';
        throw fail(code, 'YouTube source could not be reached');
      }
      if (!response || response.status < 200 || response.status >= 300 || response.data?.status === false) {
        throw fail('NO_FORMATS', 'YouTube source did not return media');
      }
      const data = response.data || {};
      const video = kind === 'video' ? (selectVideo(data.videos, quality) || selectVideo(data.result?.videos, quality)) : null;
      const direct = kind === 'audio' ? usableUrl(data.audio) : video?.url;
      if (!direct) throw fail('NO_FORMATS', 'YouTube source did not return the requested media');
      return {
        provider: 'Hector', url: direct, ext: kind === 'audio' ? 'mp3' : 'mp4',
        title: typeof data.title === 'string' ? data.title.slice(0, 250) : '',
        quality: video?.quality || undefined,
        headers: { 'User-Agent': UA },
      };
    },
  };
}

const enabled = () => process.env.FAKE_YTDLP !== '1' && process.env.HECTOR_DISABLED !== '1';

module.exports = { ENDPOINT, UA, enabled, usableUrl, selectVideo, createClient };
