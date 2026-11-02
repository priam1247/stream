/**
 * Browser-embed utilities adapted from spences10/sveltekit-embed (MIT).
 *
 * That project renders 21 iframe embed components in SvelteKit. The useful,
 * framework-independent pieces are ported here: safe aspect-ratio parsing,
 * public embed-URL builders, lazy-load defaults, and the term-by-term fuzzy
 * ranking used by its docs search. No Svelte code is used.
 */

export const EMBED_IFRAME_DEFAULTS = Object.freeze({
  loading: 'lazy' as const,
  width: '100%',
  height: '152px',
  allow: 'encrypted-media; clipboard-write',
});

/** How long to show a loading state for script-based embeds (ms). */
export const EMBED_LOAD_GIVE_UP_MS = 8000;

/** "16:9" → "aspect-ratio: 16 / 9;", falling back to 16:9. */
export function getAspectRatio(ratio: string): string {
  const [width, height] = String(ratio || '')
    .split(':')
    .map(Number);
  if (!(width > 0) || !(height > 0)) return 'aspect-ratio: 16 / 9;';
  return `aspect-ratio: ${width} / ${height};`;
}

const YT_ID = /^[-_0-9A-Za-z]{11}$/;
const LIST_ID = /^[\w-]{8,64}$/;

function safeUrl(link: string): URL | null {
  try {
    const url = new URL(String(link).trim());
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Build the public iframe/player URL for a shared link, or null when the link
 * is not one of the recognised providers. These are browser player URLs, not
 * downloadable streams.
 */
export function buildEmbedUrl(link: string): string | null {
  const url = safeUrl(link);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (host === 'open.spotify.com' || host === 'spotify.com') {
    const match = url.pathname.match(/\/(?:intl-[a-z-]+\/)?(track|album|playlist|show|episode)\/([A-Za-z0-9]+)/i);
    return match
      ? `https://open.spotify.com/embed/${match[1].toLowerCase()}/${match[2]}`
      : null;
  }
  if (host === 'deezer.com' || host === 'www.deezer.com' || host === 'widget.deezer.com') {
    const match = url.pathname.match(/\/(?:[a-z]{2}\/)?(track|album|playlist|show)\/(\d+)/i);
    return match
      ? `https://widget.deezer.com/widget/auto/${match[1].toLowerCase()}/${match[2]}`
      : null;
  }
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.toString())}&visual=true`;
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    const video = url.searchParams.get('v')
      || (host === 'youtu.be' ? url.pathname.slice(1) : '')
      || url.pathname.match(/\/embed\/([^/?#]+)/)?.[1];
    if (YT_ID.test(video || '')) return `https://www.youtube-nocookie.com/embed/${video}`;
    const list = url.searchParams.get('list');
    if (list && LIST_ID.test(list)) {
      return `https://www.youtube-nocookie.com/embed/?videoseries&list=${list}`;
    }
    return null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const match = url.pathname.match(/\/(?:video\/)?(\d+)/);
    return match ? `https://player.vimeo.com/video/${match[1]}` : null;
  }
  if (host.endsWith('tiktok.com')) {
    const match = url.pathname.match(/(?:\/video\/|\/player\/v1\/)(\d{8,25})/);
    return match ? `https://www.tiktok.com/player/v1/${match[1]}` : null;
  }
  return null;
}

/** True when a link is already an embed/player URL rather than a shared link. */
export function isEmbedUrl(link: string): boolean {
  const url = safeUrl(link);
  if (!url) return false;
  return /\/embed\//.test(url.pathname)
    || /(?:^|\.)(widget|player|w)\./.test(url.hostname)
    || /\/player\//.test(url.pathname);
}

/** Characters of `term` appear in `text` in order ("ytb" in "youtube"). */
export function isSubsequence(term: string, text: string): boolean {
  let index = 0;
  for (const character of text) {
    if (character === term[index]) index++;
    if (index === term.length) return true;
  }
  return false;
}

const SCORE = Object.freeze({
  exact: 120,
  prefix: 100,
  includes: 70,
  keywordPrefix: 50,
  keywordIncludes: 35,
  detail: 20,
  subsequence: 10,
});

export interface SearchableCommand {
  name: string;
  aliases: string[];
  summary: string;
  usage: string;
}

/**
 * Every query term must match somewhere in the command. Returns 0 for a
 * non-match and a positive score used to order results. This replaces a plain
 * `includes` filter with ranked, typo-tolerant matching while keeping the same
 * fields searchable.
 */
export function scoreCommandQuery(query: string, command: SearchableCommand): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  const title = command.name.toLowerCase();
  const keywords = command.aliases.map((alias) => alias.toLowerCase());
  const detail = `${command.summary} ${command.usage}`.toLowerCase();

  let total = 0;
  for (const term of terms) {
    let score = 0;
    if (title === term) score = SCORE.exact;
    else if (title.startsWith(term)) score = SCORE.prefix;
    else if (title.includes(term)) score = SCORE.includes;
    else {
      for (const keyword of keywords) {
        if (keyword.startsWith(term)) score = Math.max(score, SCORE.keywordPrefix);
        else if (keyword.includes(term)) score = Math.max(score, SCORE.keywordIncludes);
      }
      if (!score && detail.includes(term)) score = SCORE.detail;
      if (!score && term.length >= 3 && isSubsequence(term, title)) score = SCORE.subsequence;
    }
    if (!score) return 0;
    total += score;
  }
  return total;
}
