import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetModules(); });
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('strict browser session', () => {
  it('keeps the login only in memory and removes previously stored tokens', async () => {
    const session = await import('../lib/client-session');
    localStorage.setItem(session.AUTH_TOKEN_STORAGE_KEY, 'old-local-token');
    sessionStorage.setItem(session.AUTH_TOKEN_STORAGE_KEY, 'old-tab-token');
    session.setSavedSessionToken('new-memory-token');
    expect(localStorage.getItem(session.AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(session.AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(session.getSavedSessionToken()).toBe('new-memory-token');
    expect(session.authHeaders()).toMatchObject({ Authorization: 'Bearer new-memory-token' });
  });

  it('requires sign-in after a fresh page even if old storage or a cookie is restored', async () => {
    const session = await import('../lib/client-session');
    session.setSavedSessionToken('before-reload');
    localStorage.setItem(session.AUTH_TOKEN_STORAGE_KEY, 'old-local-token');
    sessionStorage.setItem(session.AUTH_TOKEN_STORAGE_KEY, 'old-tab-token');
    document.cookie = 'zafar_session=old-cookie; path=/';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    vi.resetModules(); // A full document load starts a new JavaScript runtime.
    const reopened = await import('../lib/client-session');
    expect(await reopened.fetchCurrentSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(reopened.AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(reopened.AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    document.cookie = 'zafar_session=; Max-Age=0; path=/';
  });

  it('can navigate within the page and clears the token before a failed sign-out request', async () => {
    const session = await import('../lib/client-session');
    session.setSavedSessionToken('in-memory');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (url === '/api/auth/me') return { ok: true, json: async () => ({ user: { email: 'member@example.com' }, quota: null }) };
      throw new Error('network offline');
    }));
    expect(await session.fetchCurrentSession()).toMatchObject({ user: { email: 'member@example.com' } });
    await session.performSignOut();
    expect(session.getSavedSessionToken()).toBe('');
  });
});
