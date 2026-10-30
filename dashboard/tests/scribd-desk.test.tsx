import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSavedSessionToken, setSavedSessionToken } from '../lib/client-session';
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

function mockApi(search: SearchReply, run?: () => Promise<Response>, status?: () => Record<string, unknown>, isAdmin = true, email = 'owner@example.com') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { isAdmin, email } });
    if (url === '/api/scribd/status') {
      return reply(status ? status() : { panelOnline: true, state: 'idle', active: 0, finished: 0, failed: 0, cancelled: false, items: [] });
    }
    if (url === '/api/scribd/files') return reply({ files: [] });
    if (url.startsWith('/api/scribd/thumb?')) return { ok: true, blob: async () => new Blob(['image'], { type: 'image/jpeg' }) } as Response;
    if (url === '/api/scribd/file-ticket') return reply({ ok: true });
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

beforeEach(() => {
  setSavedSessionToken('test-session');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test-cover'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  cleanup();
  clearSavedSessionToken();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Scribd desk', () => {
  it('shows small covers in batches and keeps selections when results are hidden', async () => {
    const hits = Array.from({ length: 18 }, (_, i) => book(i + 1));
    const fetchMock = mockApi(() => ({ hits, page: 1, max_page: 1, total: hits.length }));
    const { container, unmount } = render(<ScribdDesk />);

    expect(screen.queryByText('Panel settings')).toBeNull();
    expect(screen.queryByText('How it downloads')).toBeNull();
    expect(screen.queryByText('searchable text')).toBeNull();
    submitSearch();

    const first = await screen.findByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement;
    expect(screen.getByText('Showing 12 of 18')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Select Book 13' })).toBeNull();
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:test-cover'));
    const coverCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/scribd/thumb?'));
    expect(coverCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-session' });
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
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-cover');
  });

  it('falls back gracefully if a returned cover fails to load', async () => {
    mockApi(() => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }));
    const { container } = render(<ScribdDesk />);
    submitSearch();
    await screen.findByRole('checkbox', { name: 'Select Book 1' });
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    const image = container.querySelector('img');
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
    const fetchMock = mockApi(() => ({ hits: [], page: 1, max_page: 1 }), undefined, () => ({
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
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scribd pages' })).getByRole('button', { name: 'Queue' }));
    expect((await screen.findByRole('progressbar', { name: 'Progress for Working book' })).getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('5 / 10 pages reported')).toBeTruthy();
    expect(screen.getByText('The browser stopped.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'local.pdf' })).toBeNull();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scribd pages' })).getByRole('button', { name: 'Files' }));
    expect(screen.queryByRole('progressbar', { name: 'Progress for Working book' })).toBeNull();
    const localFile = screen.getByRole('link', { name: 'local.pdf' });
    expect(localFile.getAttribute('href')).toBe('/api/scribd/file?name=local.pdf');
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(localFile);
    await waitFor(() => expect(downloadClick).toHaveBeenCalledOnce());
    const ticket = fetchMock.mock.calls.find(([url]) => String(url) === '/api/scribd/file-ticket');
    expect(ticket?.[1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer test-session' } });
    expect(JSON.parse(String(ticket?.[1]?.body))).toEqual({ name: 'local.pdf' });
    fireEvent.click(screen.getByRole('link', { name: 'Save' }));
    await waitFor(() => expect(downloadClick).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/scribd/file-ticket')).toHaveLength(2);
    downloadClick.mockRestore();
    const drimeLinks = screen.getAllByRole('link', { name: 'Open Drime' });
    expect(drimeLinks[0].getAttribute('href')).toBe('https://dri.me/shared');
    expect(drimeLinks[1].getAttribute('href')).toBe('https://app.drime.cloud/');
    expect(screen.getByText(/No share link was supplied/)).toBeTruthy();
  });

  it('shows the authorization error instead of downloading when PDF access is revoked', async () => {
    const fetchMock = mockApi(() => ({ hits: [] }), undefined, () => ({
      panelOnline: true, state: 'done', active: 0, finished: 1, failed: 0, cancelled: false,
      items: [{ id: '1', title: 'Book', status: 'done', pdf: 'local.pdf', size: 10 }],
    }));
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input) === '/api/scribd/file-ticket'
      ? reply({ error: 'Scribd access has been revoked.' }, 403)
      : original(input, init));
    render(<ScribdDesk />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scribd pages' })).getByRole('button', { name: 'Files' }));
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(await screen.findByRole('link', { name: 'Save' }));
    expect(await screen.findByText('Scribd access has been revoked.')).toBeTruthy();
    expect(downloadClick).not.toHaveBeenCalled();
    downloadClick.mockRestore();
  });

  it('sends cancellation and clear commands only after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = mockApi(() => ({ hits: [] }), undefined, () => ({
      panelOnline: true, state: 'running', active: 1, finished: 0, failed: 0, cancelled: false,
      items: [{ id: '1', title: 'Working book', status: 'running', done: 1, total: 10, detail: '', error: '', pdf: '', size: 0, started: 0, offloaded: false, recovered: false, drime: null }],
    }));
    render(<ScribdDesk />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scribd pages' })).getByRole('button', { name: 'Queue' }));
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

  it('keeps selected books, favourites and recent searches on this device for the same account only', async () => {
    mockApi(() => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }));
    const first = render(<ScribdDesk bottomNav />);
    submitSearch('algebra');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Book 1 to favourites' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('zafar_scribd_preferences_v1:owner@example.com') || '{}');
      expect(saved.selected).toHaveLength(1);
      expect(saved.favorites).toHaveLength(1);
      expect(saved.history).toContain('algebra');
    });
    first.unmount();

    const sameAccount = render(<ScribdDesk bottomNav />);
    expect(await screen.findByRole('button', { name: 'Download selected (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Favourites \(1\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'algebra' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Favourites \(1\)/ }));
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(true);
    sameAccount.unmount();

    mockApi(() => ({ hits: [book(1)], page: 1, max_page: 1, total: 1 }), undefined, undefined, false, 'other@example.com');
    render(<ScribdDesk />);
    expect(await screen.findByText('Only administrators can start or cancel downloads.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download selected (0)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'algebra' })).toBeNull();
  });

  it('sorts loaded results without changing the search request', async () => {
    mockApi(() => ({ hits: [book(2), book(1)], page: 1, max_page: 1, total: 2 }));
    render(<ScribdDesk />);
    submitSearch();
    await screen.findByRole('checkbox', { name: 'Select Book 1' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort loaded results' }), { target: { value: 'title' } });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0].getAttribute('aria-label')).toBe('Select Book 1');
  });


  it('keeps search results, collapsed state and selection when switching between Scribd pages', async () => {
    mockApi(() => ({ hits: [book(1), book(2)], page: 1, max_page: 1, total: 2 }));
    render(<ScribdDesk />);
    submitSearch('algebra');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Book 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide results' }));
    const pages = screen.getByRole('navigation', { name: 'Scribd pages' });
    fireEvent.click(within(pages).getByRole('button', { name: 'Queue' }));
    expect(screen.getByRole('heading', { name: 'Download queue' })).toBeTruthy();
    expect(screen.queryByRole('searchbox', { name: 'Search Scribd' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit selected books' })).toBeNull();
    fireEvent.click(within(pages).getByRole('button', { name: 'Files' }));
    expect(screen.getByRole('heading', { name: /Finished PDFs/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Download queue' })).toBeNull();
    fireEvent.click(within(pages).getByRole('button', { name: 'Search' }));
    expect((screen.getByRole('searchbox', { name: 'Search Scribd' }) as HTMLInputElement).value).toBe('algebra');
    expect(screen.getByRole('button', { name: 'Download selected (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show results' }));
    expect((screen.getByRole('checkbox', { name: 'Select Book 1' }) as HTMLInputElement).checked).toBe(true);
  });

  it('stops status polling while the desk is hidden and refreshes on return', async () => {
    const fetchMock = mockApi(() => ({ hits: [] }));
    const clear = vi.spyOn(window, 'clearInterval');
    const { rerender } = render(<ScribdDesk active={false} />);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/auth/me')).toBe(true));
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/scribd/status')).toHaveLength(0);
    rerender(<ScribdDesk active />);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/scribd/status')).toHaveLength(1));
    rerender(<ScribdDesk active={false} />);
    expect(clear).toHaveBeenCalled();
    rerender(<ScribdDesk active />);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/scribd/status')).toHaveLength(2));
  });

  it('never exposes queue controls to an authorized member', async () => {
    mockApi(() => ({ hits: [book(1)] }), undefined, () => ({
      panelOnline: true, state: 'running', active: 1, finished: 0, failed: 0, cancelled: false,
      items: [{ id: '1', title: 'Working book', status: 'running', done: 1, total: 10, detail: '', error: '', pdf: '', size: 0, started: 0, offloaded: false, recovered: false, drime: null }],
    }), false);
    render(<ScribdDesk />);
    await screen.findByText('Only administrators can start or cancel downloads.');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scribd pages' })).getByRole('button', { name: 'Queue' }));
    expect(await screen.findByText('Working book')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel downloads' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear queue' })).toBeNull();
  });


  it('does not cancel or clear the queue when confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = mockApi(() => ({ hits: [] }), undefined, () => ({
      panelOnline: true, state: 'running', active: 1, finished: 0, failed: 0, cancelled: false,
      items: [{ id: '1', title: 'Working book', status: 'running', done: 1, total: 10, detail: '', error: '', pdf: '', size: 0, started: 0, offloaded: false, recovered: false, drime: null }],
    }));
    render(<ScribdDesk />);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Scribd pages' })).getByRole('button', { name: 'Queue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel downloads' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear queue' }));
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => ['/api/scribd/reset', '/api/scribd/clear'].includes(String(url)))).toBe(false);
  });

});
