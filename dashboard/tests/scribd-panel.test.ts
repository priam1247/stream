// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  isAdmin: true,
}));
vi.mock('../lib/storage', () => ({
  DEFAULT_SCRIBD_PANEL_URL: 'https://default.example',
  getScribdConnectionConfig: mocks.getConfig,
  saveScribdConnectionConfig: mocks.saveConfig,
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => ({ user: { isAdmin: mocks.isAdmin }, quota: null })),
}));

import {
  DEFAULT_SCRIBD_WEB_URL, cleanPanelUrl, clearScribdQueue, findScribdDocuments, getScribdHealth,
  getScribdStatus, readScribdFile, readScribdThumbnail, resetScribdJob,
  safeDrimeShareUrl, safeScribdName, scribdPanelConfig, startScribdJob,
  testScribdConnection,
} from '../lib/scribd-panel';
import { GET as getConfig, PATCH as patchConfig } from '../app/api/scribd/config/route';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function req(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://dashboard.test${path}`, body === undefined ? undefined : {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('SCRIBD_WEB_URL', 'https://saved.example/service?old=1#fragment');
  vi.stubEnv('SCRIBD_WEB_TOKEN', 'old-secret');
  mocks.getConfig.mockReset().mockResolvedValue({ panelUrl: 'https://saved.example/service?old=1#fragment', panelKey: 'old-secret', updatedAt: 123 });
  mocks.saveConfig.mockReset().mockResolvedValue({ updatedAt: 456 });
  mocks.isAdmin = true;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Scribd service configuration', () => {
  it('uses the current panel address and no token without consulting old settings', async () => {
    vi.stubEnv('SCRIBD_WEB_URL', undefined);
    vi.stubEnv('SCRIBD_WEB_TOKEN', undefined);
    mocks.getConfig.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect(DEFAULT_SCRIBD_WEB_URL).toBe('http://195.123.189.181:25803');
    expect(await scribdPanelConfig()).toEqual({ baseUrl: DEFAULT_SCRIBD_WEB_URL, key: '' });
    expect(mocks.getConfig).not.toHaveBeenCalled();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await getScribdStatus();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe(DEFAULT_SCRIBD_WEB_URL);
    expect(url.pathname).toBe('/api/job');
    expect(url.searchParams.has('t')).toBe(false);
  });

  it('accepts optional environment overrides without consulting old settings', async () => {
    vi.stubEnv('SCRIBD_WEB_URL', ' https://new.example/base/?t=leak#fragment ');
    vi.stubEnv('SCRIBD_WEB_TOKEN', undefined);
    expect(await scribdPanelConfig()).toEqual({ baseUrl: 'https://new.example/base', key: '' });
    vi.stubEnv('SCRIBD_WEB_TOKEN', ' new-secret ');
    expect(await scribdPanelConfig()).toEqual({ baseUrl: 'https://new.example/base', key: 'new-secret' });
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it('rejects credentials and unsafe URL schemes', () => {
    expect(cleanPanelUrl('https://web.example:443/service/?t=secret#part')).toBe('https://web.example/service');
    for (const input of ['https://user:pass@web.example', 'ftp://web.example', 'javascript:alert(1)', 'not a URL']) {
      expect(cleanPanelUrl(input)).toBe('');
    }
  });

  it('probes public health without a token and validates protected job access', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/health')) return new Response('ok');
      return jsonResponse({ items: [], cancelled: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await testScribdConnection()).toEqual({ reachable: true, locked: null, keyAccepted: true, version: null, error: null });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.has('t')).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('t')).toBe('old-secret');
  });

  it('rejects invalid configuration without making a request', async () => {
    vi.stubEnv('SCRIBD_WEB_URL', 'https://user:secret@web.example');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await getScribdHealth()).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gates the config route, reports the effective address, and does not save unused settings', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname.endsWith('/health') ? new Response('ok') : jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.isAdmin = false;
    expect((await getConfig(req('/api/scribd/config'))).status).toBe(403);
    expect((await patchConfig(req('/api/scribd/config', { panelKey: 'new' }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.isAdmin = true;
    const response = await getConfig(req('/api/scribd/config'));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, panelUrl: 'https://saved.example/service', hasPanelKey: true });
    expect(JSON.stringify(body)).not.toContain('old-secret');
    const refused = await patchConfig(req('/api/scribd/config', { panelUrl: 'https://example.com', panelKey: 'new-key' }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('saved panel settings are no longer used') });
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});

describe('Scribd web API adapter', () => {
  it('normalizes real job items, counts, filenames and share URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      active: 999, finished: 999, failed: 999, cancelled: false,
      items: [
        { id: '1', title: 'Running', status: 'running', done: '3', total: 10 },
        { id: '2', title: 'Waiting', status: 'queued', done: -1, total: 'invalid' },
        { id: '3', status: 'failed', error: 'Browser failed' },
        { id: 'disk:book..pdf', status: 'done', pdf: 'book..pdf', recovered: true },
        { id: '4', status: 'done', pdf: '../escape.pdf', offloaded: true, drime: { id: 9, name: 'cloud.pdf', url: 'https://dri.me.evil.example/x' } },
        { id: '', status: 'done' }, null,
      ],
    })));
    const result = await getScribdStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({ state: 'running', active: 2, finished: 2, failed: 1, cancelled: false });
    expect(result.data.items).toHaveLength(5);
    expect(result.data.items[0]).toMatchObject({ done: 3, total: 10 });
    expect(result.data.items[1]).toMatchObject({ done: 0, total: 0 });
    expect(result.data.items[3]).toMatchObject({ pdf: 'book..pdf', recovered: true });
    expect(result.data.items[4]).toMatchObject({ pdf: '', drime: { id: '9', url: '' } });
    expect(safeDrimeShareUrl('https://dri.me/example')).toBe('https://dri.me/example');
    for (const url of ['http://dri.me/example', 'https://dri.me.evil.test/x', 'https://user:pass@dri.me/x']) {
      expect(safeDrimeShareUrl(url)).toBe('');
    }
  });

  it('never returns upstream tokens in errors and does not follow redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Failed for old-secret' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getScribdStatus()).toEqual({ ok: false, status: 500, error: 'Failed for [redacted]' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    fetchMock.mockRejectedValueOnce(new Error('redirect to https://saved.example/?t=old-secret'));
    const error = await getScribdStatus();
    expect(error).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(error)).not.toContain('old-secret');
    vi.stubEnv('SCRIBD_WEB_TOKEN', 'old secret+value');
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'old+secret%2Bvalue / old%20secret%2Bvalue / old secret+value' }, 500));
    const encodedError = await getScribdStatus();
    expect(encodedError).toEqual({ ok: false, status: 500, error: '[redacted] / [redacted] / [redacted]' });
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    expect(await getScribdStatus()).toMatchObject({ ok: false, error: expect.stringContaining('took too long') });
  });

  it('rejects malformed upstream data and exposes a useful challenge', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not JSON'))
      .mockResolvedValueOnce(jsonResponse({ items: {} }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Scribd challenge' }, 429));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getScribdStatus()).toMatchObject({ ok: false, status: 502 });
    expect(await findScribdDocuments('test')).toMatchObject({ ok: false, status: 502 });
    expect(await findScribdDocuments('test')).toEqual({ ok: false, status: 429, error: 'Scribd challenge' });
  });

  it('deduplicates input, preflights history and sends only new documents', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: '1', status: 'failed' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: '1', status: 'failed' }, { id: '2', status: 'queued' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await startScribdJob({ docs: [
      { id: '1', title: 'Existing', pages: 4 },
      { id: '2', title: 'New', pages: 12, url: 'https://www.scribd.com/document/2/new' },
      { id: '2', title: 'New', pages: 12, url: 'https://www.scribd.com/document/2/new' },
    ] });
    expect(result).toMatchObject({ ok: true, data: { queued: 1, skipped: 1, acceptedIds: ['2'] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const target = new URL(String(fetchMock.mock.calls[1][0]));
    expect(target.pathname).toBe('/service/api/download');
    expect(target.searchParams.get('t')).toBe('old-secret');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ docs: [{ id: '2', title: 'New', pages: 12 }] });
  });

  it('refuses invalid input or an unconfirmed enqueue without clearing history', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await startScribdJob({ docs: [{ id: '1', url: 'https://evil.test/document/1' }] })).toMatchObject({ ok: false, status: 400 });
    expect(await startScribdJob({ docs: Array.from({ length: 201 }, (_, i) => ({ id: String(i + 1) })) })).toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] })).mockResolvedValueOnce(jsonResponse({ items: [] }));
    expect(await startScribdJob({ docs: [{ id: '1' }] })).toMatchObject({ ok: false, status: 502, error: expect.stringContaining('did not confirm') });
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/api/clear'))).toBe(true);
  });

  it('maps cancel and clear responses from the real service shape', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: '1', status: 'cancelled' }], cancelled: true }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: '2', status: 'running' }], cancelled: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await resetScribdJob()).toMatchObject({ ok: true, data: { requested: true } });
    expect(await clearScribdQueue()).toMatchObject({ ok: true, data: { state: 'running', active: 1 } });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/service/api/cancel', '/service/api/clear']);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'POST')).toBe(true);
  });

  it('validates filenames and cover responses before streaming', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('pdf data', { headers: { 'Content-Length': '8' } }))
      .mockResolvedValueOnce(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }))
      .mockResolvedValueOnce(new Response('x', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(9 * 1024 * 1024) } }));
    vi.stubGlobal('fetch', fetchMock);
    for (const bad of ['../x.pdf', 'x/y.pdf', 'x\\y.pdf', 'bad\nname.pdf', 'x.txt']) {
      expect(safeScribdName(bad)).toBe('');
      expect(await readScribdFile(bad)).toMatchObject({ ok: false, status: 400 });
    }
    expect(safeScribdName('A book...pdf')).toBe('A book...pdf');
    expect(await readScribdThumbnail('https://evil.example/cover.jpg')).toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    const pdf = await readScribdFile('A book...pdf');
    expect(pdf).toMatchObject({ ok: true, data: { filename: 'A book...pdf', length: '8' } });
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe('/service/files/A%20book...pdf');
    expect(await readScribdThumbnail('https://img.scribdassets.com/cover.jpg')).toMatchObject({ ok: false, status: 502 });
    expect(await readScribdThumbnail('https://img.scribdassets.com/cover.jpg')).toMatchObject({ ok: false, status: 502 });
  });
});
