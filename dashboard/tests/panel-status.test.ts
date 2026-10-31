import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BOTKEEP_API_BASE } from '../lib/botkeep-config';

const state = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'member' | 'anonymous',
  config: { panelUrl: 'https://panel.example.test', panelApiKey: 'secret-panel-key', panelServerId: 'server-1' },
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : { user: { isAdmin: state.role === 'admin' } }),
}));
vi.mock('../lib/storage', () => ({
  getPanelConnectionConfig: vi.fn(async () => ({ ...state.config })),
  savePanelConnectionConfig: vi.fn(),
}));
import { GET } from '../app/api/admin/panel/status/route';

const request = () => new NextRequest('http://localhost/api/admin/panel/status');

beforeEach(() => {
  state.role = 'admin';
  state.config = { panelUrl: 'https://panel.example.test', panelApiKey: 'secret-panel-key', panelServerId: 'server-1' };
});
afterEach(() => vi.unstubAllGlobals());

describe('owner-only panel resource status', () => {
  it('rejects unauthenticated users and members before probing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    state.role = 'anonymous';
    expect((await GET(request())).status).toBe(401);
    state.role = 'member';
    expect((await GET(request())).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not probe without both a key and explicit server ID', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    state.config.panelServerId = '';
    expect(await (await GET(request())).json()).toMatchObject({ configured: false, state: 'unknown', reachable: null });
    state.config.panelServerId = 'server-1';
    state.config.panelApiKey = '';
    expect(await (await GET(request())).json()).toMatchObject({ configured: false, state: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports actual state and suspension, with a no-redirect server-side token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'running' }))
      .mockResolvedValueOnce(Response.json({ status: 'suspended' }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await GET(request());
    expect(await first.json()).toMatchObject({ configured: true, reachable: true, state: 'running' });
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BOTKEEP_API_BASE}/workloads/server-1`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer secret-panel-key' } });
    expect(await (await GET(request())).json()).toMatchObject({ state: 'suspended' });
  });

  it('uses unknown instead of claiming offline for unexpected responses and failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ attributes: { current_state: 'mystery' } }))
      .mockResolvedValueOnce(new Response('secret-panel-key', { status: 403 }))
      .mockRejectedValueOnce(new Error('secret-panel-key in error'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await (await GET(request())).json()).toMatchObject({ reachable: true, state: 'unknown' });
    const rejected = await (await GET(request())).json();
    expect(rejected).toMatchObject({ reachable: true, state: 'unknown' });
    expect(JSON.stringify(rejected)).not.toContain('secret-panel-key');
    const unreachable = await (await GET(request())).json();
    expect(unreachable).toMatchObject({ reachable: false, state: 'unknown' });
    expect(JSON.stringify(unreachable)).not.toContain('secret-panel-key');
  });
});
