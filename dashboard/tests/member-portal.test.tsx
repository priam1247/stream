import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberPortal } from '../components/member-portal';
import { clearSavedSessionToken, setSavedSessionToken } from '../lib/client-session';
import { normalizeMalawiNumber } from '../lib/member-link';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('../components/scribd-desk', () => ({ ScribdDesk: () => <div>Scribd desk</div> }));

const user = { id: 1, name: 'Maya Member', email: 'maya@example.com', isAdmin: false, memberAllowed: true, isVerified: true, username: 'maya' };
const number = '265991234567';
const storeKey = 'zafar-member-link-v1:maya@example.com';
const reply = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

function setup(options: { state?: string; reachable?: boolean; existing?: boolean; role?: 'admin' | 'member'; pair?: Record<string, unknown>; unlink?: Record<string, unknown> } = {}) {
  const state = {
    numbers: options.existing ? [{ number, enabled: true, label: 'Maya', addedBy: user.email }] : [] as { number: string; enabled: boolean; label: string; addedBy: string }[],
    accounts: options.state ? [{ number, state: options.state, sessionId: 'a'.repeat(24), linkedAt: Date.UTC(2026, 0, 2) }] : [],
    reachable: options.reachable !== false,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply({ user: { ...user, isAdmin: options.role === 'admin' } });
    if (url === '/api/member/status') return reply({ ok: true, memberAllowed: true, scribdAllowed: false, botEnabledForMembers: true,
      botServerLinked: true, botReachable: state.reachable, botConnected: state.reachable, numbers: state.numbers, accounts: state.reachable ? state.accounts : null,
      commandsTotal: 999 });
    if (url === '/api/member/numbers' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      state.numbers = [{ number: body.number, enabled: true, label: body.label, addedBy: user.email }];
      return reply({ ok: true, numbers: state.numbers }, 201);
    }
    if (url === '/api/member/pair' && init?.method === 'POST') {
      return reply(options.pair || { ok: true, code: 'ABCD1234', issuedAt: Date.now(), expiresInSeconds: 60, retryAt: Date.now() + 180_000 });
    }
    if (url.startsWith('/api/member/pair?number=')) return reply({ ok: true, retryAt: 0 });
    if (url.startsWith('/api/member/pair?requestId=')) return reply({ ok: true, pending: true }, 202);
    if (url === '/api/member/unlink' && init?.method === 'POST') return reply(options.unlink || { ok: true, numbers: [] });
    return reply({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, fetchMock };
}

beforeEach(() => { localStorage.clear(); setSavedSessionToken('test-session'); window.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); clearSavedSessionToken(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('member linking experience', () => {
  it('normalizes Malawi formats and rejects invalid input', () => {
    for (const input of ['099 123 4567', '+265 991234567', '265 099 123 4567']) {
      expect(normalizeMalawiNumber(input).number).toBe(number);
    }
    expect(normalizeMalawiNumber('099abc')).toHaveProperty('error');
    expect(normalizeMalawiNumber('123')).toHaveProperty('error');
  });

  it('shows only the compact linking form for an unlinked member', async () => {
    const { fetchMock } = setup();
    render(<MemberPortal />);
    expect(await screen.findByRole('heading', { name: 'Welcome, Maya' })).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByLabelText('Phone number').getAttribute('inputmode')).toBe('tel');
    expect(screen.getByLabelText('Phone number').getAttribute('placeholder')).toBe('265991234567');
    expect(screen.getByText('Enter 265 followed by your WhatsApp number.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get code' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Console sections' })).toBeNull();
    expect(screen.queryByText(/No numbers approved|0 approved|Label/)).toBeNull();
    expect(screen.queryByText('999')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '123' } });
    fireEvent.submit(screen.getByLabelText('Phone number').closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Malawi number/i);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/member/numbers')).toBe(false);
  });

  it('issues a code, copies it, and preserves code and separate resend timer across refresh', async () => {
    const { fetchMock } = setup();
    const clipboard = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const view = render(<MemberPortal />);
    fireEvent.change(await screen.findByLabelText('Phone number'), { target: { value: '+265 099 123 4567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get code' }));
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    expect(screen.getByText(/Code valid for/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resend available in/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Take your time/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('ABCD1234'));
    const add = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/member/numbers' && init?.method === 'POST');
    expect(JSON.parse(String(add?.[1]?.body))).toEqual({ number, label: 'Maya Member' });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storeKey) || '{}')).toMatchObject({ number, code: 'ABCD1234' }));
    view.unmount();
    render(<MemberPortal />);
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resend available in/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Linked devices/)).toBeTruthy();
  });

  it('recovers an accepted queued request after refresh', async () => {
    const { fetchMock } = setup({ pair: { ok: true, pending: true, requestId: 'queue-1', retryAt: Date.now() + 180_000 } });
    const original = fetchMock.getMockImplementation()!;
    let resumed = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/member/pair?requestId=')) {
        return resumed ? reply({ ok: true, code: 'RECOVERED', issuedAt: Date.now(), expiresInSeconds: 60 }) : reply({ ok: true, pending: true }, 202);
      }
      return original(input, init);
    });
    const view = render(<MemberPortal />);
    fireEvent.change(await screen.findByLabelText('Phone number'), { target: { value: '099 123 4567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get code' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storeKey) || '{}').requestId).toBe('queue-1'));
    view.unmount(); resumed = true;
    render(<MemberPortal />);
    expect(await screen.findByText('RECOVERED')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resend available in/ }).hasAttribute('disabled')).toBe(true);
  });

  it('shows code expiry separately while the three-minute cooldown continues', async () => {
    setup({ existing: true, state: 'expired' });
    localStorage.setItem(storeKey, JSON.stringify({ number, name: 'Maya Member', code: 'OLD-CODE', issuedAt: Date.now() - 61_000,
      expiresInSeconds: 60, retryAt: Date.now() + 119_000 }));
    render(<MemberPortal />);
    expect(await screen.findByText('Code expired, get a new one')).toBeTruthy();
    expect(screen.queryByText('OLD-CODE')).toBeNull();
    expect(screen.getByRole('button', { name: /Resend available in/ }).hasAttribute('disabled')).toBe(true);
  });

  it('transitions from code to linked status after the service reports a connection', async () => {
    const { state } = setup({ existing: true, state: 'awaiting_link' });
    localStorage.setItem(storeKey, JSON.stringify({ number, name: 'Maya Member', code: 'ABCD1234', issuedAt: Date.now(), expiresInSeconds: 60, retryAt: Date.now() + 180_000 }));
    render(<MemberPortal />);
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    state.accounts[0].state = 'connected';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByText('Bot active')).toBeTruthy();
    expect(screen.queryByText('ABCD1234')).toBeNull();
    expect(screen.getByText(/4567/)).toBeTruthy();
    expect(screen.queryByText(number)).toBeNull();
  });

  it('shows member commands by category and copies the tapped command, not global stats', async () => {
    setup({ existing: true, state: 'connected' });
    const clipboard = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    render(<MemberPortal />);
    expect(await screen.findByText('Bot active')).toBeTruthy();
    expect(screen.getByText('Media')).toBeTruthy();
    expect(screen.queryByText('999')).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy .allow command/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search commands' }), { target: { value: 'song' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy .song command' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('.song'));
    expect(screen.queryByRole('button', { name: 'Copy .movie command' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search commands' }), { target: { value: '.menu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy .menu command' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('.menu'));
    expect(screen.queryByRole('button', { name: 'Copy .ping command' })).toBeNull();
  });

  it('distinguishes an offline service from a lost session and keeps the linked date', async () => {
    setup({ existing: true, reachable: false });
    localStorage.setItem(storeKey, JSON.stringify({ number, name: 'Maya Member', hadLink: true, linkedAt: Date.UTC(2026, 0, 2) }));
    render(<MemberPortal />);
    expect(await screen.findByText('Bot offline')).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.queryByText('Your number got disconnected')).toBeNull();
  });

  it('prefills a disconnected number and preserves the resend cooldown', async () => {
    setup({ existing: true, state: 'logged_out' });
    localStorage.setItem(storeKey, JSON.stringify({ number, name: 'Maya Member', hadLink: true, retryAt: Date.now() + 60_000 }));
    render(<MemberPortal />);
    expect(await screen.findByRole('heading', { name: 'Your number got disconnected' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Maya Member');
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe(number);
    expect(screen.getByRole('button', { name: /Resend available in/ }).hasAttribute('disabled')).toBe(true);
  });

  it('requests a fresh code after a session is disconnected', async () => {
    setup({ existing: true, state: 'logged_out' });
    localStorage.setItem(storeKey, JSON.stringify({ number, name: 'Maya Member', hadLink: true }));
    render(<MemberPortal />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get new code' }));
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
  });

  it('keeps a queued unlink across refresh and temporary polling failures', async () => {
    const { fetchMock, state } = setup({ existing: true, state: 'connected' });
    const original = fetchMock.getMockImplementation()!;
    let pollFails = true;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/member/unlink') return reply({ ok: true, pending: true, requestId: 'unlink-1' }, 202);
      if (url.startsWith('/api/member/unlink?requestId=')) {
        return pollFails ? reply({ error: 'Temporary failure' }, 503) : reply({ ok: true, numbers: [] });
      }
      return original(input, init);
    });
    const view = render(<MemberPortal />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unlink' }));
    expect(await screen.findByText('Still checking your unlink request.')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(storeKey) || '{}').unlinkRequestId).toBe('unlink-1');
    state.accounts[0].state = 'logged_out';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.queryByText('Your number got disconnected')).toBeNull();
    expect(screen.getByRole('button', { name: 'Unlinking…' }).hasAttribute('disabled')).toBe(true);
    view.unmount(); pollFails = false;
    render(<MemberPortal />);
    expect(await screen.findByText('Your number has been unlinked.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get code' })).toBeTruthy();
  });

  it('asks for confirmation and returns to the code page only after unlink succeeds', async () => {
    const { fetchMock } = setup({ existing: true, state: 'connected' });
    render(<MemberPortal />);
    await screen.findByText('Bot active');
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Unlink this number?')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/member/unlink')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, unlink' }));
    expect(await screen.findByText('Your number has been unlinked.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get code' })).toBeTruthy();
    expect(screen.queryByText('Bot active')).toBeNull();
  });

  it('retains the existing tool navigation for an administrator', async () => {
    setup({ role: 'admin' });
    render(<MemberPortal />);
    const nav = await screen.findByRole('navigation', { name: 'Console sections' });
    for (const title of ['Numbers (0)', 'Commands', 'Vault', 'Scribd', 'Status']) {
      expect(within(nav).getByRole('button', { name: title })).toBeTruthy();
    }
  });
});
