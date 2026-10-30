import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemberPortal } from '../components/member-portal';
import { clearSavedSessionToken, setSavedSessionToken } from '../lib/client-session';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as Response);

beforeEach(() => { localStorage.clear(); setSavedSessionToken('test-session'); window.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); clearSavedSessionToken(); localStorage.clear(); vi.unstubAllGlobals(); });

it('retains the owner’s real Scribd search across main tabs regardless of a member grant', async () => {
  let granted = true;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { id: 1, name: 'Member', email: 'owner@example.com', isAdmin: true } });
    if (url === '/api/member/status') return reply({ ok: true, memberAllowed: true, scribdAllowed: granted, botEnabledForMembers: true, botServerLinked: true, botReachable: true, botConnected: true, numbers: [] });
    if (url === '/api/scribd/status') return reply({ panelOnline: true, state: 'idle', active: 0, finished: 0, failed: 0, cancelled: false, items: [] });
    if (url === '/api/scribd/find') return reply({ hits: [{ id: '100001', title: 'Algebra book', url: 'https://www.scribd.com/document/100001', pages: 10, views: '', author: '' }], page: 1, max_page: 1, total: 1 });
    return reply({});
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemberPortal />);
  const mainNav = await screen.findByRole('navigation', { name: 'Console sections' });
  // Wait for the grant rather than the initial, deliberately private state.
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/member/status')).toBe(true));
  fireEvent.click(within(mainNav).getByRole('button', { name: 'Scribd' }));
  fireEvent.change(await screen.findByRole('searchbox', { name: 'Search Scribd' }), { target: { value: 'algebra' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Algebra book' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide results' }));

  fireEvent.click(within(mainNav).getByRole('button', { name: 'Numbers (0)' }));
  expect(screen.queryByRole('searchbox', { name: 'Search Scribd' })).toBeNull();
  fireEvent.click(within(mainNav).getByRole('button', { name: 'Scribd' }));
  expect((screen.getByRole('searchbox', { name: 'Search Scribd' }) as HTMLInputElement).value).toBe('algebra');
  expect(screen.getByRole('button', { name: 'Download selected (1)' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Show results' }));
  expect((screen.getByRole('checkbox', { name: 'Select Algebra book' }) as HTMLInputElement).checked).toBe(true);

  fireEvent.click(within(mainNav).getByRole('button', { name: 'Numbers (0)' }));
  granted = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/member/status').length).toBeGreaterThan(1));
  fireEvent.click(within(mainNav).getByRole('button', { name: 'Scribd' }));
  expect(await screen.findByRole('searchbox', { name: 'Search Scribd' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Scribd is private' })).toBeNull();
});
