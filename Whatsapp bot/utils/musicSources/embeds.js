'use strict';

/**
 * Public embed / player URL registry.
 *
 * Adapted from spences10/sveltekit-embed (MIT): that project ships 21 Svelte
 * iframe components plus a GenericEmbed fallback. WhatsApp cannot render an
 * iframe, so the useful part for this bot is the *data* behind those
 * components — the public player host, the link shape, and how to turn an
 * embed URL back into the link a person actually shares (and vice versa).
 *
 * Wiring:
 *   • music / audio / video embed links are normalised to their canonical
 *     URL, then resolved through the keyless catalog layer (metadata → public
 *     YouTube/SoundCloud upload) or handed straight to yt-dlp;
 *   • `.embed <link>` reports both URLs and the iframe attributes;
 *   • every provider has an inverse `embed` URL for link previews.
 *
 * No accounts, API keys, cookies or DRM are involved. These are browser
 * player URLs, not stream/manifest endpoints.
 */

const C = require('./constants');

const clean = (value) => String(value ?? '').trim();

const urlOf = (text) => {
  const m = clean(text).match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[),.;]+$/, '') : '';
};
const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); }
  catch { return ''; }
};
const hostMatches = (url, hosts) => {
  const host = hostOf(url);
  return hosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
};
const paramsOf = (url) => {
  try { return new URL(url).searchParams; }
  catch { return new URLSearchParams(); }
};
const toHttps = (url) => (/^http:\/\//i.test(url) ? `https://${url.slice(7)}` : url);
const domainOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
};

const YT_ID = /^[-_0-9A-Za-z]{11}$/;
const LIST_ID = /^[\w-]{8,64}$/;

/**
 * Each provider exposes `match(url)` →
 *   { isEmbed, kind, id, canonical, embed } or null.
 * `downloadable: false` means the canonical link is a catalog page that must
 * go through metadata resolution first (yt-dlp cannot download a Spotify or
 * Deezer page).
 */
const PROVIDERS = Object.freeze([
  {
    key: 'spotify', label: 'Spotify', category: 'music',
    hosts: ['spotify.com'], downloadable: false,
    allow: 'encrypted-media', height: '152px',
    match(url) {
      const m = String(url).match(
        /(?:open\.)?spotify\.com\/(embed\/)?(?:intl-[a-z-]+\/)?(track|album|playlist|show|episode)\/([A-Za-z0-9]+)/i,
      );
      if (!m) return null;
      const kind = m[2].toLowerCase(), id = m[3];
      return {
        isEmbed: Boolean(m[1]), kind, id,
        canonical: `https://open.spotify.com/${kind}/${id}`,
        embed: `https://open.spotify.com/embed/${kind}/${id}`,
      };
    },
  },
  {
    key: 'deezer', label: 'Deezer', category: 'music',
    hosts: ['deezer.com'], downloadable: false,
    allow: 'encrypted-media; clipboard-write', height: '300px',
    match(url) {
      const m = String(url).match(
        /(?:widget\.)?deezer\.com\/(widget\/(?:auto|light|dark)\/)?(?:[a-z]{2}\/)?(track|album|playlist|show)\/(\d+)/i,
      );
      if (!m) return null;
      const kind = m[2].toLowerCase(), id = m[3];
      return {
        isEmbed: Boolean(m[1]), kind, id,
        canonical: `https://www.deezer.com/${kind}/${id}`,
        embed: `https://widget.deezer.com/widget/auto/${kind}/${id}`,
      };
    },
  },
  {
    key: 'soundcloud-player', label: 'SoundCloud player', category: 'music',
    hosts: ['soundcloud.com'], downloadable: true,
    allow: 'autoplay', height: '300px',
    note: 'The public player carries the real track URL in its ?url= parameter.',
    match(url) {
      if (!/^https?:\/\/w\.soundcloud\.com\/player\//i.test(url)) return null;
      const target = paramsOf(url).get('url');
      if (!target || !/^https?:\/\//i.test(target)) return null;
      const canonical = toHttps(target);
      return {
        isEmbed: true,
        kind: /\/sets?\//i.test(canonical) ? 'playlist' : 'track',
        id: '', canonical, embed: url,
      };
    },
  },
  {
    key: 'soundcloud', label: 'SoundCloud', category: 'music',
    hosts: ['soundcloud.com'], downloadable: true,
    allow: 'autoplay', height: '300px',
    match(url) {
      if (/^https?:\/\/(?:w\.|player\.)soundcloud\.com\//i.test(url)) return null;
      const canonical = toHttps(url);
      return {
        isEmbed: false,
        kind: /\/sets?\//i.test(canonical) ? 'playlist' : 'track',
        id: '', canonical,
        embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(canonical)}&visual=true`,
      };
    },
  },
  {
    key: 'youtube', label: 'YouTube', category: 'video',
    hosts: ['youtube.com', 'youtube-nocookie.com', 'youtu.be'],
    downloadable: true,
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
    height: '100%',
    note: 'youtube-nocookie.com/embed/ does not set cookies until play is pressed.',
    match(url) {
      const u = new URL(url);
      const path = u.pathname; // preserve case: YouTube ids are case-sensitive
      const pathLower = path.toLowerCase();
      const list = u.searchParams.get('list');
      if (/\/embed\//.test(pathLower)) {
        const id = path.split(/\/embed\//i)[1].split(/[/?#]/)[0];
        if (YT_ID.test(id)) {
          return {
            isEmbed: true, kind: 'video', id,
            canonical: `https://www.youtube.com/watch?v=${id}`,
            embed: `https://www.youtube-nocookie.com/embed/${id}`,
          };
        }
      }
      if (list && LIST_ID.test(list) && (pathLower === '/embed' || /videoseries/i.test(url))) {
        return {
          isEmbed: true, kind: 'playlist', id: list,
          canonical: `https://www.youtube.com/playlist?list=${list}`,
          embed: `https://www.youtube-nocookie.com/embed/?videoseries&list=${list}`,
        };
      }
      const v = u.searchParams.get('v') || (domainOf(url) === 'youtu.be' ? path.slice(1) : '');
      if (YT_ID.test(v || '')) {
        return {
          isEmbed: false, kind: 'video', id: v,
          canonical: `https://www.youtube.com/watch?v=${v}`,
          embed: `https://www.youtube-nocookie.com/embed/${v}`,
        };
      }
      if (list && LIST_ID.test(list)) {
        return {
          isEmbed: false, kind: 'playlist', id: list,
          canonical: `https://www.youtube.com/playlist?list=${list}`,
          embed: `https://www.youtube-nocookie.com/embed/?videoseries&list=${list}`,
        };
      }
      return null;
    },
  },
  {
    key: 'vimeo', label: 'Vimeo', category: 'video',
    hosts: ['vimeo.com'], downloadable: true,
    allow: 'autoplay; fullscreen; picture-in-picture', height: '100%',
    match(url) {
      const m = String(url).match(/(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/i);
      if (!m) return null;
      const id = m[1];
      return {
        isEmbed: /player\.vimeo\.com\/video\//i.test(url), kind: 'video', id,
        canonical: `https://vimeo.com/${id}`,
        embed: `https://player.vimeo.com/video/${id}`,
      };
    },
  },
  {
    key: 'tiktok', label: 'TikTok', category: 'video',
    hosts: ['tiktok.com'], downloadable: true,
    allow: 'autoplay; encrypted-media; picture-in-picture', height: '100%',
    note: 'Player links carry the numeric id but no @username; yt-dlp may need the full post URL.',
    match(url) {
      const m = String(url).match(/(?:player\/v1\/|embed\/v\d+\/|\/video\/)(\d{8,25})/i);
      if (!m) return null;
      const id = m[1];
      const canonical = /\/player\/v1\/|\/embed\/v\d+\//i.test(url)
        ? toHttps(url) : `https://www.tiktok.com/video/${id}`;
      return {
        isEmbed: /\/player\/v1\/|\/embed\/v\d+\//i.test(url), kind: 'video', id,
        canonical, embed: `https://www.tiktok.com/player/v1/${id}`,
      };
    },
  },
  {
    key: 'anchor', label: 'Anchor.fm', category: 'audio',
    hosts: ['anchor.fm'], downloadable: true, height: '100px',
    match(url) {
      const m = String(url).match(/anchor\.fm\/([^\s?#]+)/i);
      if (!m) return null;
      const path = m[1];
      return {
        isEmbed: /\/embed\//i.test(path), kind: 'episode', id: path.split('/').pop(),
        canonical: `https://anchor.fm/${path}`, embed: `https://anchor.fm/${path}`,
      };
    },
  },
  {
    key: 'buzzsprout', label: 'Buzzsprout', category: 'audio',
    hosts: ['buzzsprout.com'], downloadable: true, height: '200px',
    match(url) {
      const m = String(url).match(/buzzsprout\.com\/(\d+\/[^\s?#]+)/i);
      if (!m) return null;
      const path = m[1];
      return {
        isEmbed: /iframe=true/i.test(url), kind: 'episode', id: path.split('/')[0],
        canonical: `https://www.buzzsprout.com/${path}`,
        embed: `https://www.buzzsprout.com/${path}?client_source=admin&iframe=true`,
      };
    },
  },
  {
    key: 'simplecast', label: 'SimpleCast', category: 'audio',
    hosts: ['simplecast.com'], downloadable: true, height: '200px',
    match(url) {
      const m = String(url).match(/(?:player\.)?simplecast\.com\/([A-Za-z0-9-]{8,})/i);
      if (!m) return null;
      const id = m[1];
      return {
        isEmbed: /player\.simplecast\.com\//i.test(url), kind: 'episode', id,
        canonical: `https://player.simplecast.com/${id}`,
        embed: `https://player.simplecast.com/${id}`,
      };
    },
  },
  {
    key: 'zencastr', label: 'Zencastr', category: 'audio',
    hosts: ['zencastr.com'], downloadable: true, height: '200px',
    note: 'Rendered by https://zencastr.com/static/js/embed-player.js.',
    match(url) {
      const m = String(url).match(/zencastr\.com\/embed\/([A-Za-z0-9_-]+)/i);
      if (!m) return null;
      return {
        isEmbed: true, kind: 'episode', id: m[1],
        canonical: `https://zencastr.com/embed/${m[1]}`,
        embed: `https://zencastr.com/embed/${m[1]}`,
      };
    },
  },
  {
    key: 'bluesky', label: 'Bluesky', category: 'social',
    hosts: ['bsky.app'], downloadable: true, height: 'auto',
    match(url) {
      const m = String(url).match(
        /(?:embed\.bsky\.app\/embed\/|bsky\.app\/profile\/)([^\s?#]+(?:\/app\.bsky\.feed\.post\/[^\s?#]+)?)/i,
      );
      if (!m) return null;
      const tail = m[1];
      if (tail.includes('app.bsky.feed.post/')) {
        const [did, rkey] = tail.split('/app.bsky.feed.post/');
        return {
          isEmbed: /embed\.bsky\.app/i.test(url), kind: 'post', id: rkey,
          canonical: `https://bsky.app/profile/${did}/post/${rkey}`,
          embed: `https://embed.bsky.app/embed/${tail}`,
        };
      }
      return {
        isEmbed: /embed\.bsky\.app/i.test(url), kind: 'post', id: tail,
        canonical: `https://bsky.app/profile/${tail}`, embed: url,
      };
    },
  },
  {
    key: 'threads', label: 'Threads', category: 'social',
    hosts: ['threads.com', 'threads.net'], downloadable: true, height: 'auto',
    match(url) {
      const m = String(url).match(/threads\.(?:com|net)\/t\/([A-Za-z0-9_-]+)/i);
      if (!m) return null;
      const id = m[1];
      return {
        isEmbed: /\/embed\//i.test(url), kind: 'post', id,
        canonical: `https://www.threads.com/t/${id}`,
        embed: `https://www.threads.com/t/${id}/embed/1`,
      };
    },
  },
  {
    key: 'toot', label: 'Mastodon', category: 'social',
    hosts: [], downloadable: true, height: 'auto',
    note: 'Instance-run embed script: https://{instance}/embed.js.',
    match(url) {
      const m = String(url).match(/^https?:\/\/([^/]+)\/(@[\w.-]+)\/(\d{5,})\/embed\/?$/i);
      if (!m) return null;
      return {
        isEmbed: true, kind: 'post', id: m[3],
        canonical: `https://${m[1]}/${m[2]}/${m[3]}`,
        embed: `https://${m[1]}/${m[2]}/${m[3]}/embed`,
      };
    },
  },
  {
    key: 'tweet', label: 'X / Twitter', category: 'social',
    hosts: ['twitter.com', 'x.com'], downloadable: true, height: 'auto',
    note: 'Rendered by https://platform.twitter.com/widgets.js.',
    match(url) {
      const m = String(url).match(/(?:twitter|tweet|www\.|mobile\.|x)\.?com\/([\w]+\/status\/\d+)/i);
      if (!m) return null;
      const path = m[1];
      return {
        isEmbed: false, kind: 'post', id: path.split('/').pop(),
        canonical: `https://twitter.com/${path}`, embed: `https://twitter.com/${path}`,
      };
    },
  },
  {
    key: 'codepen', label: 'CodePen', category: 'code',
    hosts: ['codepen.io'], downloadable: true, height: '400px',
    match(url) {
      const m = String(url).match(/codepen\.io\/(?:team\/codepen\/embed\/|[\w-]+\/pen\/)([A-Za-z]{6,10})/i);
      if (!m) return null;
      const id = m[1];
      return {
        isEmbed: /\/embed\//i.test(url), kind: 'pen', id,
        canonical: `https://codepen.io/pen/${id}`,
        embed: `https://codepen.io/team/codepen/embed/${id}`,
      };
    },
  },
  {
    key: 'gist', label: 'GitHub Gist', category: 'code',
    hosts: ['gist.github.com'], downloadable: true, height: '300px',
    match(url) {
      const m = String(url).match(/gist\.github\.com\/([\w.-]+\/[0-9a-f]{5,})(\.pibb)?/i);
      if (!m) return null;
      const path = m[1];
      return {
        isEmbed: Boolean(m[2]), kind: 'gist', id: path.split('/').pop(),
        canonical: `https://gist.github.com/${path}`,
        embed: `https://gist.github.com/${path}.pibb`,
      };
    },
  },
  {
    key: 'stackblitz', label: 'StackBlitz', category: 'code',
    hosts: ['stackblitz.com'], downloadable: true, height: '500px',
    match(url) {
      const m = String(url).match(/stackblitz\.com\/edit\/([\w.-]{2,})/i);
      if (!m) return null;
      const id = m[1];
      return {
        isEmbed: /embed=1/i.test(url), kind: 'project', id,
        canonical: `https://stackblitz.com/edit/${id}`,
        embed: `https://stackblitz.com/edit/${id}?embed=1`,
      };
    },
  },
  {
    key: 'slides', label: 'Slides', category: 'code',
    hosts: ['slides.com'], downloadable: true, height: '500px',
    match(url) {
      const m = String(url).match(/slides\.com\/([\w.-]+\/[\w.-]+)(?:\/embed)?/i);
      if (!m) return null;
      return {
        isEmbed: /\/embed/i.test(url), kind: 'deck', id: m[1],
        canonical: `https://slides.com/${m[1]}`,
        embed: `https://slides.com/${m[1]}/embed`,
      };
    },
  },
  {
    key: 'relive', label: 'Relive', category: 'video',
    hosts: ['relive.cc'], downloadable: true, height: '500px',
    match(url) {
      const m = String(url).match(/relive\.cc\/view\/([\w-]+)(?:\/widget)?/i);
      if (!m) return null;
      return {
        isEmbed: /\/widget/i.test(url), kind: 'activity', id: m[1],
        canonical: `https://www.relive.cc/view/${m[1]}`,
        embed: `https://www.relive.cc/view/${m[1]}/widget`,
      };
    },
  },
  {
    key: 'guild', label: 'Guild', category: 'social',
    hosts: ['guild.host'], downloadable: true, height: '400px',
    match(url) {
      const m = String(url).match(/guild\.host\/embeds\/(\w+)\/([\w.-]+)\/([\w/-]+)/i);
      if (!m) return null;
      return {
        isEmbed: true, kind: m[1], id: m[2],
        canonical: `https://guild.host/${m[1]}/${m[2]}`, embed: toHttps(url),
      };
    },
  },
]);

const MUSIC_CATEGORIES = new Set(['music', 'audio', 'video']);

/** Recognise a link (canonical or embed) and return both URL forms. */
function parseLink(text) {
  const url = urlOf(text);
  if (!url) return null;
  for (const provider of PROVIDERS) {
    if (provider.hosts.length && !hostMatches(url, provider.hosts)) continue;
    let hit;
    try { hit = provider.match(url); } catch { hit = null; }
    if (!hit) continue;
    return {
      provider: provider.key,
      label: provider.label,
      category: provider.category,
      note: provider.note || '',
      url,
      isEmbed: Boolean(hit.isEmbed),
      kind: hit.kind || '',
      id: hit.id || '',
      canonical: hit.canonical,
      embed: hit.embed,
      downloadable: provider.downloadable !== false,
      iframe: iframeProps({
        src: hit.embed, title: `${provider.label} ${hit.kind || 'embed'}`,
        allow: provider.allow, height: provider.height,
      }),
    };
  }
  // GenericEmbed: any https URL can still be reported / passed to yt-dlp.
  return {
    provider: 'generic', label: 'Generic embed', category: 'other', note: '',
    url, isEmbed: false, kind: '', id: '',
    canonical: toHttps(url), embed: toHttps(url), downloadable: true,
    iframe: iframeProps({ src: toHttps(url), title: 'Embed' }),
  };
}

function iframeProps({ src = '', title = 'Embed', allow = '', height = '' } = {}) {
  return {
    src,
    title,
    loading: C.EMBED_IFRAME_DEFAULTS.loading,
    width: C.EMBED_IFRAME_DEFAULTS.width,
    height: height || C.EMBED_IFRAME_DEFAULTS.height,
    allow: allow || C.EMBED_IFRAME_DEFAULTS.allow,
  };
}

/** Canonical shared URL for a recognised link, or null for unknown/generic. */
function toCanonical(text) {
  const info = parseLink(text);
  return info && info.provider !== 'generic' ? info.canonical : null;
}
const canonicalize = toCanonical;

/** Player/iframe URL for a recognised link (inverse of toCanonical). */
function toEmbed(text) {
  return parseLink(text)?.embed || null;
}

/** A link that came from an embed code rather than a share sheet. */
function isEmbedUrl(text) {
  return Boolean(parseLink(text)?.isEmbed);
}

/** Music/audio/video embed links the music commands should intercept. */
function isMusicEmbed(text) {
  const info = parseLink(text);
  return Boolean(info?.isEmbed && MUSIC_CATEGORIES.has(info.category));
}

const supportedProviders = () => PROVIDERS.map((p) => ({
  key: p.key, label: p.label, category: p.category,
}));

/** Plain-text card for the `.embed` command. */
function describe(text) {
  const info = parseLink(text);
  if (!info) return null;
  const lines = [
    `🔗 *${info.label}*${info.kind ? ` · ${info.kind}` : ''}`,
    info.isEmbed ? 'Type: embed / player URL' : 'Type: shared link',
    '',
    `Canonical: ${info.canonical}`,
    `Embed: ${info.embed}`,
  ];
  if (info.id) lines.push(`ID: ${info.id}`);
  lines.push('', `iframe: loading=${info.iframe.loading}, height=${info.iframe.height}, allow="${info.iframe.allow}"`);
  if (info.note) lines.push(`ℹ️ ${info.note}`);
  if (MUSIC_CATEGORIES.has(info.category)) {
    lines.push('', `Tip: .song ${info.canonical} (MP3) · .ytv ${info.canonical} (MP4)`);
    lines.push('     .embed <link> --audio | --video delivers it directly.');
  }
  return lines.join('\n');
}

module.exports = {
  PROVIDERS, parseLink, iframeProps,
  toCanonical, canonicalize, toEmbed,
  isEmbedUrl, isMusicEmbed,
  supportedProviders, describe,
};
