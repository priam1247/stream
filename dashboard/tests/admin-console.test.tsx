import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConsole } from '../components/admin-console';
import { clearSavedSessionToken, setSavedSessionToken } from '../lib/client-session';

const router = { replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('../components/scribd-desk', () => ({ ScribdDesk: ({ page }: { page?: string }) => <div data-testid="scribd-desk" data-page={page}>Scribd desk</div> }));

const member = { email: 'member@example.com', name: 'A Member', isAdmin: false, isVerified: true, allowed: true, scribdAllowed: false, numbersCount: 1, createdAt: '2026-01-01' };
const overview = {
  ok: true, adminEmail: 'owner@example.com', botServerLinked: true, botReachable: true, connected: true,
  botNumber: '265991234567', botApiUrl: '', hasBotToken: false, hasBotSyncToken: true,
  botEnabledForMembers: true, storageEngine: 'cloudflare-d1', connectionMode: 'heartbeat', whitelistSync: 'pending',
  lastSeenSecondsAgo: 3, botVersion: '1.2.3', ramUsedMB: 32, diskUsedMB: 10, diskBudgetMB: 100, queueLight: 0, queueHeavy: 0,
  panelConfigured: true, panelUrl: 'https://panel.example.com', panelServerId: 'server-1', hasPanelApiKey: true,
  scribdTokenConfigured: false, scribdSecureTransport: false,
  users: [{ number: '265991234567', label: 'Mobile', enabled: true, addedBy: 'member@example.com' }], members: [member],
};
function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function mockApi(scribdFailed = 0) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { id: 1, name: 'Owner', email: 'owner@example.com', isAdmin: true }, quota: null });
    if (url === '/api/admin/status') return reply(overview);
    if (url === '/api/scribd/status') return reply({ panelOnline: true, state: 'idle', active: 0, finished: 0, failed: scribdFailed, cancelled: false, items: [] });
    if (url === '/api/admin/panel/status') return reply({ configured: true, reachable: true, state: 'running', error: null, checkedAt: Date.now() });
    if (url === '/api/admin/activity') return reply({ ok: true, storage: 'local', events: [{ id: '1', category: 'members', action: 'Scribd access granted', actor: 'owner@example.com', detail: 'member@example.com', outcome: 'success', createdAt: '2026-01-01T12:00:00Z' }] });
    if (url === '/api/admin/members/scribd') return reply({ ok: true, members: [{ ...member, scribdAllowed: JSON.parse(String(init?.body)).allowed }] });
    if (url.endsWith('/sync')) return reply({ ok: true, result: 'pending', message: 'Saved list is waiting for the bot to check in. Sync is not yet confirmed.' });
    if (url === '/api/admin/panel') return reply({ ok: true, message: 'Request accepted.' });
    return reply({ error: `Unexpected request: ${url}` }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
beforeEach(() => { localStorage.clear(); setSavedSessionToken('test-session'); window.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); clearSavedSessionToken(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('owner control room', () => {
  it('redirects members before fetching or showing owner controls', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
      ? reply({ user: { id: 2, name: 'Member', email: 'member@example.com', isAdmin: false } })
      : reply({ error: 'Unexpected request' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminConsole />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByRole('navigation', { name: 'Owner sections' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/'))).toBe(false);
  });

  it('opens focused owner pages from workspace shortcuts', async () => {
    mockApi();
    render(<AdminConsole />);
    await screen.findByRole('heading', { name: 'Overview' });
    const shortcuts = screen.getByRole('region', { name: 'Workspace shortcuts' });
    expect(within(shortcuts).getByText('1 enabled number')).toBeTruthy();
    fireEvent.click(within(shortcuts).getByRole('button', { name: /WhatsApp/ }));
    expect(screen.getByRole('navigation', { name: 'WhatsApp pages' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Owner sections' })).getByRole('button', { name: 'Home' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Workspace shortcuts' })).getByRole('button', { name: /Members/ }));
    expect(screen.getByRole('heading', { name: 'Members' })).toBeTruthy();
  });

  it('shows separate observed service states, warnings and website-only activity', async () => {
    mockApi();
    render(<AdminConsole />);
    const status = await screen.findByRole('region', { name: 'Service status' });
    expect(within(status).getByText('Service bridge')).toBeTruthy();
    expect(within(status).getByRole('button', { name: /Service bridge/ }).textContent).toContain('Reachable');
    expect(within(status).getByText('Connected')).toBeTruthy();
    expect(within(status).getByText('Pending')).toBeTruthy();
    expect(await screen.findByText('Scribd direct access may be open')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Activity' }));
    expect(screen.getByText(/Website-only alerts update/)).toBeTruthy();
    expect(screen.queryByRole('searchbox', { name: 'Search activity' })).toBeNull();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity pages' })).getByRole('button', { name: 'History' }));
    expect(screen.getByText(/server’s local disk/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Current alerts' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search activity' }), { target: { value: 'member@example.com' } });
    expect(screen.getByText('Scribd access granted')).toBeTruthy();
  });

  it('reduces the unread badge for each opened alert without hiding unresolved warnings', async () => {
    mockApi();
    const view = render(<AdminConsole />);
    const nav = await screen.findByRole('navigation', { name: 'Owner sections' });
    const activity = within(nav).getByRole('button', { name: 'Activity' });
    const mobileActivity = within(screen.getByRole('navigation', { name: 'Owner shortcuts' })).getByRole('button', { name: 'Activity' });
    await waitFor(() => expect(activity.getAttribute('aria-description')).toBe('3 unread alerts'));
    expect(within(mobileActivity).getByText('3')).toBeTruthy();
    fireEvent.click(activity);
    expect(screen.getByText('3 active · 3 unread')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Number list awaiting sync/ }));
    expect(activity.getAttribute('aria-description')).toBe('2 unread alerts');
    expect(within(mobileActivity).getByText('2')).toBeTruthy();
    fireEvent.click(activity);
    expect(screen.getByText('3 active · 2 unread')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Number list awaiting sync/ })).toBeTruthy();

    view.unmount();
    render(<AdminConsole />);
    const restoredNav = await screen.findByRole('navigation', { name: 'Owner sections' });
    const restoredActivity = within(restoredNav).getByRole('button', { name: 'Activity' });
    await waitFor(() => expect(restoredActivity.getAttribute('aria-description')).toBe('2 unread alerts'));
    fireEvent.click(restoredActivity);
    fireEvent.click(screen.getByRole('button', { name: /Scribd direct access may be open/ }));
    expect(restoredActivity.getAttribute('aria-description')).toBe('1 unread alert');
    fireEvent.click(restoredActivity);
    fireEvent.click(screen.getByRole('button', { name: /Scribd connection is unencrypted/ }));
    expect(restoredActivity.hasAttribute('aria-description')).toBe(false);
    fireEvent.click(restoredActivity);
    expect(screen.getByText('3 active · 0 unread')).toBeTruthy();
  });

  it('marks a warning new again only after its condition is known to have cleared', async () => {
    const fetchMock = mockApi();
    const original = fetchMock.getMockImplementation()!;
    let syncState = 'pending';
    fetchMock.mockImplementation(async (input, init) => String(input) === '/api/admin/status'
      ? reply({ ...overview, whitelistSync: syncState }) : original(input, init));
    render(<AdminConsole />);
    const nav = await screen.findByRole('navigation', { name: 'Owner sections' });
    const activity = within(nav).getByRole('button', { name: 'Activity' });
    await waitFor(() => expect(activity.getAttribute('aria-description')).toBe('3 unread alerts'));
    fireEvent.click(activity);
    fireEvent.click(screen.getByRole('button', { name: /Number list awaiting sync/ }));
    expect(activity.getAttribute('aria-description')).toBe('2 unread alerts');
    fireEvent.click(within(nav).getByRole('button', { name: 'Home' }));
    syncState = 'unknown';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Unconfirmed')).toBeTruthy());
    syncState = 'pending';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Pending')).toBeTruthy());
    expect(activity.getAttribute('aria-description')).toBe('2 unread alerts');
    syncState = 'synced';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Up to date')).toBeTruthy());
    syncState = 'pending';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(activity.getAttribute('aria-description')).toBe('3 unread alerts'));
  });

  it('grants a member Scribd access individually', async () => {
    const fetchMock = mockApi();
    render(<AdminConsole />);
    const nav = await screen.findByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Members' }));
    fireEvent.click(screen.getByRole('button', { name: /Grant Scribd/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/admin/members/scribd')).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/admin/members/scribd')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ email: 'member@example.com', allowed: true });
    expect(await screen.findByRole('button', { name: /Revoke Scribd/ })).toBeTruthy();
  });

  it('filters numbers, retries sync and asks for confirmation before stopping the bot', async () => {
    const fetchMock = mockApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AdminConsole />);
    const nav = await screen.findByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'WhatsApp' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' }), { target: { value: 'unmatched' } });
    expect(screen.getByText('No numbers match this filter')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' }), { target: { value: 'Mobile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync for +265991234567' }));
    expect(await screen.findByText(/Sync is not yet confirmed/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'WhatsApp pages' })).getByRole('button', { name: 'Power' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop service' }));
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/admin/panel' && init?.method === 'POST')).toBe(false);
  });

  it('separates WhatsApp numbers, status, power and connection settings without losing drafts', async () => {
    mockApi();
    render(<AdminConsole />);
    const mainNav = await screen.findByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(mainNav).getByRole('button', { name: 'WhatsApp' }));
    const pages = screen.getByRole('navigation', { name: 'WhatsApp pages' });
    expect(within(pages).getByRole('button', { name: 'Numbers' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Live Server Analytics' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop service' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' }), { target: { value: 'Mobile' } });

    fireEvent.click(within(pages).getByRole('button', { name: 'Status' }));
    expect(screen.getByText('Reported version 1.2.3')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Live Server Analytics' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop service' })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search WhatsApp numbers' })).toBeNull();

    fireEvent.click(within(pages).getByRole('button', { name: 'Power' }));
    expect(screen.getByRole('button', { name: 'Stop service' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Live Server Analytics' })).toBeNull();

    fireEvent.click(within(pages).getByRole('button', { name: 'Sync' }));
    const token = screen.getByLabelText('BOT_SYNC_TOKEN') as HTMLInputElement;
    fireEvent.change(token, { target: { value: 'draft sync token' } });
    expect(screen.queryByLabelText('PANEL_URL')).toBeNull();
    fireEvent.click(within(pages).getByRole('button', { name: 'Hosting' }));
    expect(screen.getByLabelText('PANEL_URL')).toBeTruthy();
    expect(screen.queryByLabelText('BOT_SYNC_TOKEN')).toBeNull();
    fireEvent.click(within(pages).getByRole('button', { name: 'Sync' }));
    expect((screen.getByLabelText('BOT_SYNC_TOKEN') as HTMLInputElement).value).toBe('draft sync token');
    fireEvent.click(within(pages).getByRole('button', { name: 'Numbers' }));
    expect((screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' }) as HTMLInputElement).value).toBe('Mobile');
    expect(screen.getByText(/Pausing stops new requests, not approved numbers/)).toBeTruthy();
  });

  it('keeps activity filters and sends a number-sync alert to the numbers page', async () => {
    mockApi();
    render(<AdminConsole />);
    const mainNav = await screen.findByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(mainNav).getByRole('button', { name: 'Activity' }));
    const pages = screen.getByRole('navigation', { name: 'Activity pages' });
    fireEvent.click(within(pages).getByRole('button', { name: 'History' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search activity' }), { target: { value: 'member@example.com' } });
    fireEvent.click(within(pages).getByRole('button', { name: 'Alerts' }));
    fireEvent.click(screen.getByRole('button', { name: /Number list awaiting sync/ }));
    expect(within(screen.getByRole('navigation', { name: 'WhatsApp pages' })).getByRole('button', { name: 'Numbers' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' })).toBeTruthy();
    fireEvent.click(within(mainNav).getByRole('button', { name: 'Activity' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Activity pages' })).getByRole('button', { name: 'History' }));
    expect((screen.getByRole('searchbox', { name: 'Search activity' }) as HTMLInputElement).value).toBe('member@example.com');
  });


  it('opens a failed Scribd alert on the queue even after the desk was visited', async () => {
    mockApi(1);
    render(<AdminConsole />);
    const mainNav = await screen.findByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(mainNav).getByRole('button', { name: 'Scribd' }));
    expect(screen.getByTestId('scribd-desk').getAttribute('data-page')).toBe('search');
    fireEvent.click(within(mainNav).getByRole('button', { name: 'Activity' }));
    fireEvent.click(await screen.findByRole('button', { name: /1 failed Scribd job/ }));
    expect(screen.getByTestId('scribd-desk').getAttribute('data-page')).toBe('queue');
    expect(within(mainNav).getByRole('button', { name: 'Scribd' }).getAttribute('aria-current')).toBe('page');
  });


  it('keeps a pairing code and its unlinked status when moving between WhatsApp pages', async () => {
    const receivedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(receivedAt);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/me') return reply({ user: { id: 1, name: 'Owner', email: 'owner@example.com', isAdmin: true }, quota: null });
      if (url === '/api/admin/status') return reply({ ...overview, accounts: [{ number: '265991234567', state: 'awaiting_link' }] });
      if (url === '/api/scribd/status') return reply({ panelOnline: true, state: 'idle', active: 0, finished: 0, failed: 0, cancelled: false, items: [] });
      if (url === '/api/admin/panel/status') return reply({ configured: true, reachable: true, state: 'running', error: null, checkedAt: Date.now() });
      if (url === '/api/admin/activity') return reply({ ok: true, storage: 'cloudflare-d1', events: [] });
      if (url === '/api/admin/pair' && init?.method === 'POST') return reply({ ok: true, code: 'TEST-CODE', expiresInSeconds: 60, issuedAt: receivedAt + 30_000 });
      return reply({ error: `Unexpected request: ${url}` }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminConsole />);
    const nav = await screen.findByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'WhatsApp' }));
    expect(screen.getByText('Waiting for linking')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get code' }));
    expect(await screen.findByText('TEST-CODE')).toBeTruthy();
    const pages = screen.getByRole('navigation', { name: 'WhatsApp pages' });
    fireEvent.click(within(pages).getByRole('button', { name: 'Status' }));
    expect(screen.queryByText('TEST-CODE')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View code' }));
    expect(within(pages).getByRole('button', { name: 'Numbers' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('TEST-CODE')).toBeTruthy();
    expect(screen.getByText('Waiting for linking')).toBeTruthy();
    // A future server timestamp must not extend the lifetime after returning to the page.
    clock.mockReturnValue(receivedAt + 61_000);
    fireEvent.click(within(pages).getByRole('button', { name: 'Status' }));
    fireEvent.click(screen.getByRole('button', { name: 'View code' }));
    expect(screen.getByText('Code expired')).toBeTruthy();
    expect(screen.queryByText('TEST-CODE')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss pairing code' }));
    expect(screen.queryByRole('button', { name: 'View code' })).toBeNull();
    const pairCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/admin/pair');
    expect(JSON.parse(String(pairCall?.[1]?.body))).toEqual({ number: '265991234567' });
  });

});
