import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_BASE_URL } from '../lib/panel-config';

const store = vi.hoisted(() => ({ config: { panelUrl: 'https://untrusted-old-panel.invalid', panelApiKey: 'secret-panel-key-for-testing', panelServerId: 'workload-123' } }));
vi.mock('../lib/storage', () => ({ getPanelConnectionConfig: vi.fn(async () => ({ ...store.config })) }));
import { readPanelStatus, sendPanelPowerSignal } from '../lib/panel-client';

beforeEach(() => { store.config = { panelUrl: 'https://untrusted-old-panel.invalid', panelApiKey: 'secret-panel-key-for-testing', panelServerId: 'workload-123' }; });
afterEach(() => vi.unstubAllGlobals());

describe('HiddenCloud panel client API', () => {
  it('requires an explicit ID and key and refuses unsafe IDs without calling any host', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    store.config.panelServerId = '';
    expect(await sendPanelPowerSignal('restart')).toMatchObject({ ok: false, status: 400 });
    expect(await readPanelStatus()).toMatchObject({ configured: false, state: 'unknown' });
    store.config.panelServerId = '../another';
    expect(await sendPanelPowerSignal('start')).toMatchObject({ ok: false, status: 400 });
    expect(await readPanelStatus()).toMatchObject({ state: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts one documented action with bearer and unique idempotency keys to the exact workload', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetchMock);
    expect(await sendPanelPowerSignal('restart')).toMatchObject({ ok: true, status: 204, serverId: 'workload-123' });
    expect(await sendPanelPowerSignal('stop')).toMatchObject({ ok: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PANEL_BASE_URL}/api/client/servers/workload-123/power`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer secret-panel-key-for-testing', Accept: 'application/vnd.pterodactyl.v1+json', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init.body))).toEqual({ signal: 'restart' });
    const key1 = (init.headers as Record<string, string>)['Idempotency-Key'];
    const key2 = ((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key'];
    expect(key1).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(key2).not.toBe(key1);
  });

  it('never follows a redirect or retries an uncertain outcome elsewhere', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('secret-panel-key-for-testing')).mockResolvedValueOnce(new Response(null, { status: 500 })); vi.stubGlobal('fetch', fetchMock);
    const rejected = await sendPanelPowerSignal('restart');
    expect(rejected).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(rejected)).not.toContain('secret-panel-key-for-testing');
    const failed = await sendPanelPowerSignal('start');
    expect(failed).toMatchObject({ ok: false, status: 500 });
    expect(failed.error).toMatch(/check server status before retrying/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === `${PANEL_BASE_URL}/api/client/servers/workload-123/power`)).toBe(true);
  });

  it('reports unknown when response shape or remote state is unfamiliar, without exposing errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ status: 'running' })).mockResolvedValueOnce(Response.json({ foo: 'bar' })).mockResolvedValueOnce(new Response('secret-panel-key-for-testing', { status: 403 })).mockRejectedValueOnce(new Error('secret-panel-key-for-testing')); vi.stubGlobal('fetch', fetchMock);
    expect(await readPanelStatus()).toMatchObject({ configured: true, reachable: true, state: 'running' });
    expect(await readPanelStatus()).toMatchObject({ reachable: true, state: 'unknown' });
    const rejected = await readPanelStatus();
    expect(rejected).toMatchObject({ reachable: true, state: 'unknown' });
    const unreachable = await readPanelStatus();
    expect(unreachable).toMatchObject({ reachable: false, state: 'unknown' });
    expect(JSON.stringify([rejected, unreachable])).not.toContain('secret-panel-key-for-testing');
    expect(fetchMock.mock.calls[0][0]).toBe(`${PANEL_BASE_URL}/api/client/servers/workload-123/resources`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
});
