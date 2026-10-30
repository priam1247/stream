// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../lib/types';

const state = vi.hoisted(() => ({
  user: null as AuthUser | null,
  session: null as AuthUser | null,
  readFile: vi.fn(),
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async (req: NextRequest) => req.headers.get('authorization') === 'Bearer browser-session' && state.session
    ? { user: state.session, quota: null } : null),
  getVerifiedAuthUser: vi.fn(async (email: string) => state.user?.email === email ? state.user : null),
}));
vi.mock('../lib/scribd-panel', () => ({
  safeScribdName: (name: string) => /^[^/\\\n]+\.pdf$/i.test(name) ? name : '',
  readScribdFile: state.readFile,
}));

import { POST as issueTicket } from '../app/api/scribd/file-ticket/route';
import { GET as readFile } from '../app/api/scribd/file/route';
import { signScribdDownloadTicket, scribdDownloadCookieName } from '../lib/scribd-download-ticket';

const user: AuthUser = {
  id: 1, email: 'member@example.com', name: 'Member', username: 'member',
  isVerified: true, isAdmin: false, memberAllowed: true, scribdAllowed: true,
};
function issue(name: string, authenticated = true) {
  return new NextRequest('http://dashboard.test/api/scribd/file-ticket', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer browser-session' } : {}) },
    body: JSON.stringify({ name }),
  });
}
function download(name: string, cookie = '') {
  return new NextRequest(`http://dashboard.test/api/scribd/file?name=${encodeURIComponent(name)}`, {
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET_KEY', 'test-session-key-at-least-32-characters');
  state.user = { ...user };
  state.session = { ...user };
  state.readFile.mockReset().mockImplementation(async (filename: string) => ({
    ok: true, data: { filename, length: '9', body: new Response('pdf bytes').body },
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('scoped Scribd streaming downloads', () => {
  it('issues a short-lived HttpOnly ticket and streams the requested PDF', async () => {
    const issued = await issueTicket(issue('local.pdf'));
    expect(issued.status).toBe(200);
    expect(await issued.json()).toEqual({ ok: true });
    const setCookie = issued.headers.get('set-cookie') || '';
    expect(setCookie).toContain(`${scribdDownloadCookieName('local.pdf')}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).toMatch(/Max-Age=20/i);
    expect(setCookie).toContain('Path=/api/scribd/file');
    const response = await readFile(download('local.pdf', setCookie.split(';')[0]));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    expect(await response.text()).toBe('pdf bytes');
  });

  it('does not grant general access, other files, tampered tickets or expired tickets', async () => {
    expect((await issueTicket(issue('local.pdf', false))).status).toBe(401);
    expect((await issueTicket(issue('../bad.pdf'))).status).toBe(400);
    expect((await readFile(download('local.pdf'))).status).toBe(401);
    const ticket = signScribdDownloadTicket(user.email, 'local.pdf');
    const otherCookie = `${scribdDownloadCookieName('other.pdf')}=${ticket}`;
    expect((await readFile(download('other.pdf', otherCookie))).status).toBe(401);
    const tampered = `${scribdDownloadCookieName('local.pdf')}=${ticket}x`;
    expect((await readFile(download('local.pdf', tampered))).status).toBe(401);
    vi.useFakeTimers();
    vi.advanceTimersByTime(21_000);
    const expired = `${scribdDownloadCookieName('local.pdf')}=${ticket}`;
    expect((await readFile(download('local.pdf', expired))).status).toBe(401);
    expect(state.readFile).not.toHaveBeenCalled();
  });

  it('rechecks the current account and grant even for a valid ticket', async () => {
    const ticket = signScribdDownloadTicket(user.email, 'local.pdf');
    const cookie = `${scribdDownloadCookieName('local.pdf')}=${ticket}`;
    state.user = { ...user, scribdAllowed: false };
    expect((await readFile(download('local.pdf', cookie))).status).toBe(403);
    state.user = { ...user, memberAllowed: false };
    expect((await readFile(download('local.pdf', cookie))).status).toBe(403);
    state.user = null;
    expect((await readFile(download('local.pdf', cookie))).status).toBe(401);
    expect(state.readFile).not.toHaveBeenCalled();
  });
});
