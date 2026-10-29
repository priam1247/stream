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

function mockApi(search: SearchReply, run?: () => Promise<Response>, status?: () => Record<string, unknown>, isAdmin = true) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { isAdmin } });
    if (url === '/api/scribd/status') {
      return reply(status ? status() : { panelOnline: true, state: 'idle', active: 0, finished: 0, failed: 0, cancelled: false, items: [] });
    }
    if (url === '/api/scribd/files') return reply({ files: [] });
    if (url === '/api/scribd/find') {
      const body = JSON.parse(String(init?.body || '{}')) as { page?: number; query?: string };
      return reply(search(body.page || 1, body.query || ''));
    }
    if (url === '/api/scribd/run') return run ? run() : reply({ queued: 1, acceptedIds: ['100001'], message: '1 document added to the queue.' });
    if (url === '/api/scribd/reset') return reply({ requested: true });
    if (url === '/api/scribd/clear') return reply({ items: [] });
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
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/scribd/thumb?url=${encodeURIComponent('https://img.scribdassets.com/cover.jpg')}`);
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
    const image = container.querySelector('img');
    expect(image).toBeTruthy();
    fireEvent.error(image!);
    expect(container.querySelector('img')).toBeNull();
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

  it('keeps selections the server says were already in its queue or history', async () => {
    mockApi(
      () => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }),
      async () => reply({ queued: 0, skipped: 1, acceptedIds: [], message: 'Already in the queue or history.' }),
    );
    render(<ScribdDesk />);
    submitSearch();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download selected (1)' }));
    expect(await screen.findByText('Already in the queue or history.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows actual job progress, errors, local files and offloaded Drime files', async () => {
    const item = (id: string, overrides: Record<string, unknown>) => ({
      id, title: `Document ${id}`, status: 'done', done: 0, total: 0,
      detail: '', error: '', pdf: '', size: 0, started: 0, offloaded: false, recovered: false, drime: null,
      ...overrides,
    });
    mockApi(() => ({ hits: [], page: 1, max_page: 1 }), undefined, () => ({
      panelOnline: true, state: 'running', active: 1, finished: 3, failed: 1, cancelled: false,
      items: [
        item('1', { title: 'Working book', status: 'running', done: 5, total: 10 }),
        item('2', { title: 'Failed book', status: 'failed', error: 'The browser stopped.' }),
        item('3', { title: 'Local book', pdf: 'local.pdf', size: 1024 }),
        item('4', { title: 'Cloud book', pdf: 'cloud.pdf', offloaded: true, drime: { id: '4', name: 'cloud.pdf', url: 'https://dri.me/shared' } }),
        item('5', { title: 'Private cloud book', pdf: 'private.pdf', offloaded: true, drime: { id: '5', name: 'private.pdf', url: '' } }),
      ],
    }));
    render(<ScribdDesk />);
    expect((await screen.findByRole('progressbar', { name: 'Progress for Working book' })).getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('5 / 10 pages reported')).toBeTruthy();
    expect(screen.getByText('The browser stopped.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'local.pdf' }).getAttribute('href')).toBe('/api/scribd/file?name=local.pdf');
    const drimeLinks = screen.getAllByRole('link', { name: 'Open Drime' });
    expect(drimeLinks[0].getAttribute('href')).toBe('https://dri.me/shared');
    expect(drimeLinks[1].getAttribute('href')).toBe('https://app.drime.cloud/');
    expect(screen.getByText(/No share link was supplied/)).toBeTruthy();
  });

  it('sends cancellation and clear commands only after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = mockApi(() => ({ hits: [] }), undefined, () => ({
      panelOnline: true, state: 'running', active: 1, finished: 0, failed: 0, cancelled: false,
      items: [{ id: '1', title: 'Working book', status: 'running', done: 1, total: 10, detail: '', error: '', pdf: '', size: 0, started: 0, offloaded: false, recovered: false, drime: null }],
    }));
    render(<ScribdDesk />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel downloads' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/scribd/reset')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Clear queue' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/scribd/clear')).toBe(true));
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });

  it('explains the existing administrator-only download restriction', async () => {
    mockApi(() => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }), undefined, undefined, false);
    render(<ScribdDesk />);
    submitSearch();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 1' }));
    expect(await screen.findByText('Only administrators can start or cancel downloads.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download selected (1)' }).hasAttribute('disabled')).toBe(true);
  });

  it('sends selected document metadata and retains new selections made during submission', async () => {
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
    expect(JSON.parse(String(runCall?.[1]?.body))).toEqual({ docs: [{ id: book(1).id, title: book(1).title, pages: book(1).pages, url: book(1).url }] });
    await act(async () => { resolveRun?.(reply({ queued: 1, acceptedIds: [book(1).id], message: '1 document added to the queue.' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download selected (1)' })).toBeTruthy());
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Select Book 2' }) as HTMLInputElement).checked).toBe(true);
  });
});
