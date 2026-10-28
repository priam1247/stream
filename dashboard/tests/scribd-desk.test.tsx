import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScribdDesk } from '../components/scribd-desk';
import type { ScribdHit } from '../lib/scribd-types';

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function book(n: number): ScribdHit {
  const id = String(100000 + n);
  return {
    id,
    title: `Book ${n}`,
    url: `https://www.scribd.com/document/${id}`,
    pages: n,
    views: '',
    author: '',
    thumbnail: n === 1 ? 'https://img.scribdassets.com/cover.jpg' : undefined,
  };
}

type SearchReply = (page: number, query: string) => Record<string, unknown>;

function mockApi(search: SearchReply, run?: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { isAdmin: true } });
    if (url === '/api/scribd/status') {
      return reply({ panelOnline: true, state: 'idle', progress: { page: 0, of: 0, ok: 0 }, log: [] });
    }
    if (url === '/api/scribd/files') return reply({ files: [] });
    if (url === '/api/scribd/find') {
      const body = JSON.parse(String(init?.body || '{}')) as { page?: number; query?: string };
      return reply(search(body.page || 1, body.query || ''));
    }
    if (url === '/api/scribd/run') return run ? run() : reply({ queued: 1, started: true });
    return reply({ error: 'Unexpected request' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function submitSearch(term = 'mathematics') {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Scribd' }), {
    target: { value: term },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Scribd desk', () => {
  it('shows small covers in batches and keeps selections when results are hidden', async () => {
    const hits = Array.from({ length: 18 }, (_, i) => book(i + 1));
    mockApi(() => ({ hits, page: 1, max_page: 1, total: hits.length }));
    const { container } = render(<ScribdDesk />);

    expect(screen.queryByText('Panel settings')).toBeNull();
    expect(screen.queryByText('How it downloads')).toBeNull();
    expect(screen.queryByText('searchable text')).toBeNull();
    submitSearch();

    const first = await screen.findByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement;
    expect(screen.getByText('Showing 12 of 18')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Select Book 13' })).toBeNull();
    expect(container.querySelector('img[src="https://img.scribdassets.com/cover.jpg"]')).toBeTruthy();
    expect(screen.getAllByText('Cover unavailable').length).toBeGreaterThan(0);

    fireEvent.click(first);
    expect(first.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide results' }));
    const show = screen.getByRole('button', { name: 'Show results' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox', { name: 'Select Book 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download selected (1)' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(show);
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show more results' }));
    expect(screen.getByRole('checkbox', { name: 'Select Book 18' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more results' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Select all (18)' }));
    expect(screen.getByRole('button', { name: 'Download selected (18)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByRole('button', { name: 'Download selected (0)' }).hasAttribute('disabled')).toBe(true);
  });

  it('falls back gracefully if a returned cover fails to load', async () => {
    mockApi(() => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }));
    const { container } = render(<ScribdDesk />);
    submitSearch();
    await screen.findByRole('checkbox', { name: 'Select Book 1' });
    const image = container.querySelector('img[src="https://img.scribdassets.com/cover.jpg"]');
    expect(image).toBeTruthy();
    fireEvent.error(image!);
    expect(container.querySelector('img[src="https://img.scribdassets.com/cover.jpg"]')).toBeNull();
    expect(screen.getByText('Cover unavailable')).toBeTruthy();
  });

  it('does not load a thumbnail from an untrusted host', async () => {
    mockApi(() => ({
      hits: [{ ...book(1), thumbnail: 'https://scribdassets.com.evil.test/cover.jpg' }],
      page: 1,
      max_page: 1,
      total: 1,
    }));
    const { container } = render(<ScribdDesk />);
    submitSearch();
    await screen.findByRole('checkbox', { name: 'Select Book 1' });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Cover unavailable')).toBeTruthy();
  });

  it('requests an advertised next page only after showing local results, using the original query', async () => {
    const firstPage = Array.from({ length: 13 }, (_, i) => book(i + 1));
    const fetchMock = mockApi((page) => page === 1
      ? { hits: firstPage, page: 1, max_page: 2, total: 14 }
      : { hits: [book(13), book(14)], page: 2, max_page: 2, total: 14 });
    render(<ScribdDesk />);
    submitSearch('algebra');
    await screen.findByRole('checkbox', { name: 'Select Book 1' });

    fireEvent.click(screen.getByRole('button', { name: 'Show more results' }));
    expect(screen.getByRole('checkbox', { name: 'Select Book 13' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Scribd' }), { target: { value: 'new words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show more results' }));
    await screen.findByRole('checkbox', { name: 'Select Book 14' });

    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/scribd/find');
    expect(searchCalls).toHaveLength(2);
    expect(JSON.parse(String(searchCalls[1][1]?.body))).toEqual({ query: 'algebra', page: 2 });
    expect(screen.getByText('Showing 14 of 14')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more results' })).toBeNull();
  });

  it('retains selections from an earlier search when a new search opens', async () => {
    mockApi((_page, query) => ({
      hits: [query === 'algebra' ? book(1) : book(2)],
      page: 1,
      max_page: 1,
      total: 1,
    }));
    render(<ScribdDesk />);
    submitSearch('algebra');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide results' }));
    submitSearch('geometry');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 2' }));
    expect(screen.getByRole('button', { name: 'Download selected (2)' })).toBeTruthy();
  });

  it('keeps the selection if the download request fails', async () => {
    mockApi(
      () => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }),
      async () => reply({ error: 'Administrator permission required.' }, 403),
    );
    render(<ScribdDesk />);
    submitSearch();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download selected (1)' }));
    expect(await screen.findByText('Administrator permission required.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(true);
  });

  it('sends only the selected URLs and retains new selections made during submission', async () => {
    let resolveRun: ((response: Response) => void) | undefined;
    const fetchMock = mockApi(
      () => ({ hits: [book(1), book(2)], page: 1, max_page: 1, total: 2 }),
      () => new Promise((resolve) => { resolveRun = resolve; }),
    );
    render(<ScribdDesk />);
    submitSearch();
    const first = await screen.findByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement;
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: 'Download selected (1)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Book 2' }));

    const runCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/scribd/run');
    expect(JSON.parse(String(runCall?.[1]?.body))).toEqual({ urls: [book(1).url] });
    await act(async () => { resolveRun?.(reply({ queued: 1, started: true })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download selected (1)' })).toBeTruthy());
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Select Book 2' }) as HTMLInputElement).checked).toBe(true);
  });
});
