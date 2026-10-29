import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemberPortal } from '../components/member-portal';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../components/scribd-desk', () => ({
  ScribdDesk: () => <div>Scribd desk</div>,
}));

function reply(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => { window.scrollTo = vi.fn(); });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows analytics only on the dedicated status page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/me') {
      return reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } });
    }
    return reply({
      ok: true,
      adminEmail: 'admin@example.com',
      memberAllowed: true,
      scribdAllowed: true,
      botEnabledForMembers: true,
      botServerLinked: false,
      botConnected: false,
      botNumber: null,
      numbers: [],
    });
  }));

  render(<MemberPortal />);
  const nav = await screen.findByRole('navigation', { name: 'Console sections' });
  expect(screen.queryByRole('region', { name: 'Live Server Analytics' })).toBeNull();
  fireEvent.click(within(nav).getByRole('button', { name: 'Scribd' }));
  expect(screen.queryByRole('region', { name: 'Live Server Analytics' })).toBeNull();
  expect(screen.getByText('Scribd desk')).toBeTruthy();
  fireEvent.click(within(nav).getByRole('button', { name: 'Status' }));
  expect(screen.getByRole('region', { name: 'Live Server Analytics' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'WhatsApp numbers' })).toBeNull();
  fireEvent.click(within(nav).getByRole('button', { name: 'Numbers (0)' }));
  expect(screen.queryByRole('region', { name: 'Live Server Analytics' })).toBeNull();
});

it('shows the owner-grant message instead of the Scribd desk by default', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
    ? reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } })
    : reply({ ok: true, adminEmail: 'owner@example.com', memberAllowed: true, scribdAllowed: false, botEnabledForMembers: true, botServerLinked: true, botConnected: false, botNumber: null, numbers: [] })));
  render(<MemberPortal />);
  const nav = await screen.findByRole('navigation', { name: 'Console sections' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Scribd' }));
  expect(screen.getByText('Scribd is private')).toBeTruthy();
  expect(screen.queryByText('Scribd desk')).toBeNull();
});

it('keeps Scribd private while an account is blocked, even if it has a grant', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
    ? reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } })
    : reply({ ok: true, adminEmail: 'owner@example.com', memberAllowed: false, scribdAllowed: true, botEnabledForMembers: true, botServerLinked: true, botConnected: false, botNumber: null, numbers: [] })));
  render(<MemberPortal />);
  const nav = await screen.findByRole('navigation', { name: 'Console sections' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Scribd' }));
  expect(screen.getByText('Scribd is private')).toBeTruthy();
  expect(screen.queryByText('Scribd desk')).toBeNull();
});

it('filters the member’s own numbers and distinguishes approval from pairing', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
    ? reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } })
    : reply({ ok: true, adminEmail: 'owner@example.com', memberAllowed: true, scribdAllowed: false, botEnabledForMembers: true, botServerLinked: true, botConnected: true, botNumber: null, whitelistSync: 'pending', numbers: [{ number: '265991234567', label: 'Mobile', enabled: true }] })));
  render(<MemberPortal />);
  await screen.findByRole('navigation', { name: 'Console sections' });
  expect(screen.getByText(/Approve your number, then request a code/)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search my numbers' }), { target: { value: 'no match' } });
  expect(screen.getByText('No matching numbers')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search my numbers' }), { target: { value: 'Mobile' } });
  expect(screen.getByText('+265991234567')).toBeTruthy();
});

it('explains a linking pause while still allowing a member to pause their existing number', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
    ? reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } })
    : reply({ ok: true, adminEmail: 'owner@example.com', memberAllowed: true, scribdAllowed: false, botEnabledForMembers: false, botServerLinked: true, botReachable: true, botConnected: true, botNumber: null, numbers: [{ number: '265991234567', label: 'Mobile', enabled: true }] })));
  render(<MemberPortal />);
  await screen.findByRole('navigation', { name: 'Console sections' });
  expect(screen.getByText(/New number approvals and pairing are paused/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Get Code' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Pause' }).hasAttribute('disabled')).toBe(false);
});

it('requests a second account code without treating issuance as a completed link', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } });
    if (url === '/api/member/pair' && init?.method === 'POST') {
      return reply({ ok: true, code: 'TEST-CODE', expiresInSeconds: 60, issuedAt: Date.now() });
    }
    return reply({
      ok: true, memberAllowed: true, scribdAllowed: false, botEnabledForMembers: true,
      botServerLinked: true, botReachable: true, botConnected: true, botNumber: null,
      numbers: [
        { number: '15550001111', label: 'First', enabled: true },
        { number: '15550002222', label: 'Second', enabled: true },
      ],
      accounts: [{ number: '15550001111', state: 'connected' }, { number: '15550002222', state: 'awaiting_link' }],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemberPortal />);
  await screen.findByText('Linked and connected');
  expect(screen.getByText('Waiting for linking')).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Get Code' });
  expect(buttons[0].hasAttribute('disabled')).toBe(true);
  expect(buttons[1].hasAttribute('disabled')).toBe(false);
  fireEvent.click(buttons[1]);
  expect(await screen.findByText('TEST-CODE')).toBeTruthy();
  expect(screen.getByText(/status updates only after linking succeeds/)).toBeTruthy();
  expect(screen.getByText('Waiting for linking')).toBeTruthy();
  const nav = screen.getByRole('navigation', { name: 'Console sections' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Status' }));
  expect(screen.queryByText('TEST-CODE')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View code' }));
  expect(screen.getByText('TEST-CODE')).toBeTruthy();
  expect(screen.getByText('Waiting for linking')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss pairing code' }));
  expect(screen.queryByRole('button', { name: 'View code' })).toBeNull();
  const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/member/pair');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ number: '15550002222' });
});


it('separates paper and provider pages and retains the selected page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
    ? reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } })
    : reply({ ok: true, memberAllowed: true, scribdAllowed: false, botEnabledForMembers: true, botServerLinked: true, botConnected: true, numbers: [] })));
  render(<MemberPortal />);
  const nav = await screen.findByRole('navigation', { name: 'Console sections' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Vault' }));
  const pages = screen.getByRole('navigation', { name: 'Vault pages' });
  expect(screen.getByText('MZUNI Paper Vault')).toBeTruthy();
  expect(screen.queryByText('Providers (8)')).toBeNull();
  fireEvent.click(within(pages).getByRole('button', { name: 'Providers' }));
  expect(screen.getByText('Providers (8)')).toBeTruthy();
  expect(screen.queryByText('MZUNI Paper Vault')).toBeNull();
  expect(screen.getByText('Listed')).toBeTruthy();
  fireEvent.click(within(nav).getByRole('button', { name: 'Commands' }));
  fireEvent.click(within(nav).getByRole('button', { name: 'Vault' }));
  expect(screen.getByText('Providers (8)')).toBeTruthy();
  expect(within(screen.getByRole('navigation', { name: 'Vault pages' })).getByRole('button', { name: 'Providers' }).getAttribute('aria-current')).toBe('page');
});

it('marks member status unknown if a refresh fails, then recovers', async () => {
  let unavailable = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/me') return reply({ user: { id: 1, name: 'Member', email: 'member@example.com', isAdmin: false } });
    if (unavailable) return { ok: false, status: 503, json: async () => ({ error: 'Status unavailable' }) } as Response;
    return reply({
      ok: true, memberAllowed: true, scribdAllowed: false, botEnabledForMembers: true,
      botServerLinked: true, botReachable: true, botConnected: true, botNumber: null,
      commandsTotal: 12, numbers: [{ number: '15550001111', enabled: true }],
      accounts: [{ number: '15550001111', state: 'connected' }],
    });
  }));
  render(<MemberPortal />);
  const nav = await screen.findByRole('navigation', { name: 'Console sections' });
  expect(await screen.findByText('Linked and connected')).toBeTruthy();
  fireEvent.click(within(nav).getByRole('button', { name: 'Status' }));
  expect(screen.getByText('WhatsApp connected')).toBeTruthy();

  unavailable = true;
  fireEvent.click(screen.getByTitle('Refresh'));
  expect(await screen.findByText('Status could not be refreshed.')).toBeTruthy();
  expect(screen.getByText('No current status')).toBeTruthy();
  expect(screen.queryByText('WhatsApp connected')).toBeNull();
  expect(screen.queryByText('12')).toBeNull();
  fireEvent.click(within(nav).getByRole('button', { name: 'Numbers (1)' }));
  expect(screen.getByText('Link status unknown')).toBeTruthy();

  unavailable = false;
  fireEvent.click(screen.getByTitle('Refresh'));
  expect(await screen.findByText('Linked and connected')).toBeTruthy();
});
