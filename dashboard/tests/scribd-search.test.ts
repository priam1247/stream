import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeScribdHit, safeScribdThumbnail, scribdDocumentId } from '../lib/scribd-search';

vi.mock('../lib/storage', () => ({
  DEFAULT_SCRIBD_PANEL_URL: 'https://panel.example',
  DEFAULT_SCRIBD_SEARCH_URL: 'https://search.example',
  getScribdConnectionConfig: vi.fn(),
}));

import { DEFAULT_SCRIBD_WEB_URL, findScribdDocuments } from '../lib/scribd-panel';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Scribd search results', () => {
  it('preserves real covers and makes relative document links usable', () => {
    const result = normalizeScribdHit({
      id: 123456789,
      title: 'Algebra',
      url: '/document/123456789/algebra',
      pages: '42',
      views: '3K',
      author: 'A teacher',
      thumb: '//imgv2-2-f.scribdassets.com/img/document/123456789/cover.jpg',
    });

    expect(result).toMatchObject({
      id: '123456789',
      title: 'Algebra',
      url: 'https://www.scribd.com/document/123456789/algebra',
      pages: 42,
      thumbnail: 'https://imgv2-2-f.scribdassets.com/img/document/123456789/cover.jpg',
    });
  });

  it('uses a document ID as a link and leaves absent covers absent', () => {
    expect(normalizeScribdHit({ id: '123456789' })).toMatchObject({
      title: 'Document 123456789',
      url: 'https://www.scribd.com/document/123456789',
      thumbnail: undefined,
    });
    expect(normalizeScribdHit({ title: 'No document ID or link' })).toBeNull();
    expect(normalizeScribdHit(null)).toBeNull();
  });

  it('accepts only HTTPS covers on Scribd-owned hosts', () => {
    expect(safeScribdThumbnail('https://img.scribdassets.com/book.jpg')).toBe(
      'https://img.scribdassets.com/book.jpg',
    );
    for (const url of [
      'https://scribdassets.com.evil.test/cover.jpg',
      'https://evil-scribdassets.com/cover.jpg',
      'http://img.scribdassets.com/cover.jpg',
      'https://user:password@img.scribdassets.com/cover.jpg',
      'https://img.scribdassets.com:8443/cover.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAA',
      'https://127.0.0.1/cover.jpg',
    ]) {
      expect(safeScribdThumbnail(url)).toBeUndefined();
    }
  });

  it('accepts only Scribd document URLs when deriving IDs', () => {
    expect(scribdDocumentId('https://www.scribd.com/document/123456789/Algebra')).toBe('123456789');
    expect(scribdDocumentId('https://evil.example/document/123456789')).toBeUndefined();
    expect(scribdDocumentId('https://scribd.com.evil.example/document/123456789')).toBeUndefined();
    expect(scribdDocumentId('https://www.scribd.com/document/not-a-number')).toBeUndefined();
  });

  it('forwards the web service search page, token, and real cover data', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        page: 2,
        items: [{
          id: '123456789',
          title: 'Algebra',
          url: '/document/123456789',
          thumb: 'https://img.scribdassets.com/book.jpg',
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SCRIBD_WEB_TOKEN', 'test-token');

    const result = await findScribdDocuments('algebra & geometry', 2);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.hits[0].thumbnail).toBe('https://img.scribdassets.com/book.jpg');
    expect(result.data.max_page).toBe(3);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requested, init] = fetchMock.mock.calls[0];
    const url = new URL(String(requested));
    expect(url.origin).toBe(DEFAULT_SCRIBD_WEB_URL);
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('q')).toBe('algebra & geometry');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('t')).toBe('test-token');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
  });
});
