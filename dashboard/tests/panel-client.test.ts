import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  config: { panelUrl: 'https://panel.example.test', panelApiKey: 'secret-panel-key', panelServerId: 'aaaa1111' },
  save: vi.fn(async () => ({})),
}));
vi.mock('../lib/storage', () => ({
  getPanelConnectionConfig: vi.fn(async () => ({ ...store.config })),
  savePanelConnectionConfig: store.save,
}));
import { sendPanelPowerSignal } from '../lib/panel-client';

const servers = [
  { attributes: { identifier: 'aaaa1111', uuid: 'aaaa1111-1111-1111-1111-111111111111', name: 'Bot' } },
  { attributes: { identifier: 'bbbb2222', uuid: 'bbbb2222-2222-2222-2222-222222222222', name: 'Other server' } },
];

function mockPanel(powerStatus = 404, discovered = servers) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ data: discovered });
    return new Response(null, { status: powerStatus });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  store.config = { panelUrl: 'https://panel.example.test', panelApiKey: 'secret-panel-key', panelServerId: 'aaaa1111' };
  store.save.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('safe panel power targets', () => {
  it('never retries a failed power action against another discovered server', async () => {
    const fetchMock = mockPanel();
    const result = await sendPanelPowerSignal('stop');
    expect(result.ok).toBe(false);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every(([url]) => String(url).includes('aaaa1111'))).toBe(true);
    expect(posts.some(([url]) => String(url).includes('bbbb2222'))).toBe(false);
    expect(posts.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it('requires an explicit choice when multiple servers exist', async () => {
    store.config.panelServerId = '';
    const fetchMock = mockPanel(204);
    const result = await sendPanelPowerSignal('restart');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/multiple servers/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('rejects a mismatched ID rather than switching servers', async () => {
    store.config.panelServerId = 'missing';
    const fetchMock = mockPanel(204);
    const result = await sendPanelPowerSignal('start');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('sends a successful request only to the chosen server', async () => {
    store.config.panelServerId = 'bbbb2222';
    const fetchMock = mockPanel(204);
    const result = await sendPanelPowerSignal('restart');
    expect(result).toMatchObject({ ok: true, serverId: 'bbbb2222' });
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toContain('/servers/bbbb2222/power');
  });

  it('does not retry an uncertain server error at another route or identifier', async () => {
    const fetchMock = mockPanel(500);
    const result = await sendPanelPowerSignal('restart');
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(result.error).toMatch(/check server status before retrying/i);
  });
});
