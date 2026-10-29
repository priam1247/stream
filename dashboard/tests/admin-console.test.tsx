import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConsole } from '../components/admin-console';

const router = { replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('../components/scribd-desk', () => ({ ScribdDesk: () => <div>Scribd desk</div> }));

const member = { email: 'member@example.com', name: 'A Member', isAdmin: false, isVerified: true, allowed: true, scribdAllowed: false, numbersCount: 1, createdAt: '2026-01-01' };
const overview = {
  ok: true, adminEmail: 'owner@example.com', botServerLinked: true, botReachable: true, connected: true,
  botNumber: '265991234567', botApiUrl: '', hasBotToken: false, hasBotSyncToken: true,
  botEnabledForMembers: true, storageEngine: 'cloudflare-d1', connectionMode: 'heartbeat', whitelistSync: 'pending',
  lastSeenSecondsAgo: 3, ramUsedMB: 32, diskUsedMB: 10, diskBudgetMB: 100, queueLight: 0, queueHeavy: 0,
  panelConfigured: true, panelUrl: 'https://panel.example.com', panelServerId: 'server-1', hasPanelApiKey: true,
  scribdTokenConfigured: false, scribdSecureTransport: false,
  users: [{ number: '265991234567', label: 'Mobile', enabled: true, addedBy: 'member@example.com' }], members: [member],
};
function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function mockApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { id: 1, name: 'Owner', email: 'owner@example.com', isAdmin: true }, quota: null });
    if (url === '/api/admin/status') return reply(overview);
    if (url === '/api/scribd/status') return reply({ panelOnline: true, state: 'idle', active: 0, finished: 0, failed: 0, cancelled: false, items: [] });
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
beforeEach(() => { window.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('owner control room', () => {
  it('shows separate observed service states, warnings and website-only activity', async () => {
    mockApi();
    render(<AdminConsole />);
    const status = await screen.findByRole('region', { name: 'Service status' });
    expect(within(status).getByText('Bot bridge')).toBeTruthy();
    expect(within(status).getByText('Reachable')).toBeTruthy();
    expect(within(status).getByText('Connected')).toBeTruthy();
    expect(within(status).getByText('Pending')).toBeTruthy();
    expect(await screen.findByText('Scribd direct access may be open')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Owner sections' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Activity' }));
    expect(screen.getByText(/Checks update while this page is open/)).toBeTruthy();
    expect(screen.getByText(/server’s local disk/)).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search activity' }), { target: { value: 'member@example.com' } });
    expect(screen.getByText('Scribd access granted')).toBeTruthy();
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
    fireEvent.click(within(nav).getByRole('button', { name: 'Bot' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' }), { target: { value: 'unmatched' } });
    expect(screen.getByText('No numbers match this filter')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search WhatsApp numbers' }), { target: { value: 'Mobile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry sync for +265991234567' }));
    expect(await screen.findByText(/Sync is not yet confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop bot' }));
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/admin/panel' && init?.method === 'POST')).toBe(false);
  });
});
