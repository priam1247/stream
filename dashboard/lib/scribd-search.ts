import type { ScribdHit } from './scribd-types';

/** Only load public Scribd covers; search results are untrusted input. */
export function safeScribdThumbnail(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;

  try {
    const raw = value.trim();
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    const host = url.hostname.toLowerCase();
    const allowed = ['scribd.com', 'scribdassets.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
    if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function thumbnailFrom(item: Record<string, unknown>): string | undefined {
  for (const candidate of [
    item.thumbnail,
    item.thumb,
    item.thumbnail_url,
    item.thumbnailUrl,
    item.cover,
    item.cover_url,
    item.image,
    item.image_url,
  ]) {
    const value = candidate && typeof candidate === 'object'
      ? (candidate as Record<string, unknown>).url
      : candidate;
    const thumbnail = safeScribdThumbnail(value);
    if (thumbnail) return thumbnail;
  }
  return undefined;
}

/** Keep the search service's cover when available, without changing its API. */
export function normalizeScribdHit(value: unknown): ScribdHit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? '').trim();
  const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
  const url = rawUrl.startsWith('/') && !rawUrl.startsWith('//')
    ? `https://www.scribd.com${rawUrl}`
    : rawUrl || (/^\d{6,}$/.test(id) ? `https://www.scribd.com/document/${id}` : '');
  if (!id && !url) return null;

  const pages = Number(item.pages);
  const match = item.match === 'all' || item.match === 'some' || item.match === 'none'
    ? item.match
    : undefined;
  return {
    id,
    title: String(item.title ?? '').trim() || (id ? `Document ${id}` : 'Untitled document'),
    url,
    pages: Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 0,
    views: String(item.views ?? ''),
    author: String(item.author ?? ''),
    thumbnail: thumbnailFrom(item),
    match,
  };
}
