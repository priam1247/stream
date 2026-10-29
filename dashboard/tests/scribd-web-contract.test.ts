// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' | 'anonymous' }));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => auth.role === 'anonymous' ? null : {
    user: { isAdmin: auth.role === 'admin' }, quota: null,
  }),
}));
vi.mock('../lib/storage', () => ({
  DEFAULT_SCRIBD_PANEL_URL: 'https://unused.invalid',
  getScribdConnectionConfig: vi.fn(async () => ({ panelUrl: '', panelKey: '' })),
}));

import { GET as status } from '../app/api/scribd/status/route';
import { POST as find } from '../app/api/scribd/find/route';
import { POST as run } from '../app/api/scribd/run/route';
import { POST as cancel } from '../app/api/scribd/reset/route';
import { POST as clear } from '../app/api/scribd/clear/route';
import { GET as files } from '../app/api/scribd/files/route';
import { GET as file } from '../app/api/scribd/file/route';
import { GET as link } from '../app/api/scribd/link/route';
import { GET as thumbnail } from '../app/api/scribd/thumb/route';

function request(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://dashboard.test${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function startFixture(): Promise<ChildProcessWithoutNullStreams> {
  const script = fileURLToPath(new URL('./fixtures/scribd_web_contract.py', import.meta.url));
  const child = spawn('python3', ['-u', script], {
    stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Scribd fixture did not start: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes('\n')) return;
      clearTimeout(timer);
      const value = Number(stdout.split('\n')[0]);
      if (Number.isInteger(value) && value > 0) resolve(value);
      else reject(new Error(`Invalid fixture port: ${stdout} ${stderr}`));
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Scribd fixture exited (${code}): ${stderr}`)); });
  });
  vi.stubEnv('SCRIBD_WEB_URL', `http://127.0.0.1:${port}`);
  vi.stubEnv('SCRIBD_WEB_TOKEN', 'contract-token');
  return child;
}

let child: ChildProcessWithoutNullStreams;
beforeAll(async () => { child = await startFixture(); }, 15_000);
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  vi.unstubAllEnvs();
});
beforeEach(() => { auth.role = 'admin'; });

describe.sequential('dashboard routes with the real Python Scribd web handler', () => {
  it('enforces session and administrator gates before reaching the service', async () => {
    auth.role = 'anonymous';
    expect((await status(request('/api/scribd/status'))).status).toBe(401);
    expect((await thumbnail(request('/api/scribd/thumb?url=https%3A%2F%2Fimg.scribdassets.com%2Fa.jpg'))).status).toBe(401);
    auth.role = 'member';
    expect((await run(request('/api/scribd/run', { docs: [{ id: '100001' }] }))).status).toBe(403);
    expect((await cancel(request('/api/scribd/reset', {}))).status).toBe(403);
    expect((await clear(request('/api/scribd/clear', {}))).status).toBe(403);
    expect((await status(request('/api/scribd/status'))).status).toBe(200);
  });

  it('searches and proxies a cover with query-token authentication', async () => {
    const initial = await status(request('/api/scribd/status'));
    expect(await initial.json()).toMatchObject({ panelOnline: true, state: 'idle', items: [] });

    const found = await find(request('/api/scribd/find', { query: 'algebra & geometry', page: 1 }));
    const data = await found.json();
    expect(found.status).toBe(200);
    expect(data).toMatchObject({ page: 1, max_page: 2, hits: [
      { id: '100001', title: 'Local book', url: 'https://www.scribd.com/document/100001/local', pages: 3, thumbnail: 'https://img.scribdassets.com/cover.jpg' },
      { id: '100002', title: 'Cloud book' },
    ] });
    expect(JSON.stringify(data)).not.toContain('contract-token');
    const second = await find(request('/api/scribd/find', { query: 'algebra & geometry', page: 2 }));
    expect((await second.json()).hits[0].id).toBe('100003');
    const end = await find(request('/api/scribd/find', { query: 'algebra & geometry', page: 3 }));
    expect(await end.json()).toMatchObject({ page: 3, max_page: 3, hits: [] });

    const image = await thumbnail(request(`/api/scribd/thumb?url=${encodeURIComponent(data.hits[0].thumbnail)}`));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(32);
    expect((await thumbnail(request('/api/scribd/thumb?url=https%3A%2F%2Fevil.example%2Fa.jpg'))).status).toBe(400);

    const challenged = await find(request('/api/scribd/find', { query: 'challenge' }));
    expect(challenged.status).toBe(429);
    expect(await challenged.json()).toMatchObject({ error: 'Scribd challenge (fixture)' });
  });

  it('enqueues real job objects, streams local files, and reports private Drime results', async () => {
    const docs = [
      { id: '100001', title: 'Local book', pages: 3, url: 'https://www.scribd.com/document/100001/local' },
      { id: '100002', title: 'Cloud book', pages: 2, url: 'https://www.scribd.com/document/100002/cloud' },
    ];
    const started = await run(request('/api/scribd/run', { docs }));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ queued: 2, skipped: 0, acceptedIds: ['100001', '100002'] });
    await vi.waitFor(async () => {
      const response = await status(request('/api/scribd/status'));
      const state = await response.json();
      expect(state.finished).toBe(2);
      expect(state.active).toBe(0);
      expect(state.items[0]).toMatchObject({ id: '100001', status: 'done', done: 3, total: 3 });
    }, { timeout: 4000, interval: 40 });

    const listed = await files(request('/api/scribd/files'));
    const fileList = await listed.json();
    expect(fileList.files).toHaveLength(2);
    expect(fileList.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'local.pdf', source: 'server' }),
      expect.objectContaining({ name: 'cloud.pdf', source: 'drime' }),
    ]));
    const local = await file(request('/api/scribd/file?name=local.pdf'));
    expect(local.status).toBe(200);
    expect(local.headers.get('content-type')).toBe('application/pdf');
    expect(await local.text()).toBe('%PDF-1.4\nfixture PDF\n%%EOF\n');
    const fileLink = await link(request('/api/scribd/link?name=local.pdf'));
    expect(await fileLink.json()).toMatchObject({ url: '/api/scribd/file?name=local.pdf' });
    expect((await file(request('/api/scribd/file?name=..%2Flocal.pdf'))).status).toBe(400);
    expect((await file(request('/api/scribd/file?name=missing.pdf'))).status).toBe(404);

    const duplicate = await run(request('/api/scribd/run', { docs }));
    expect(await duplicate.json()).toMatchObject({ queued: 0, skipped: 2, acceptedIds: [] });
    expect((await run(request('/api/scribd/run', { docs: [{ id: '../../bad' }] }))).status).toBe(400);
  });

  it('cancels an active job and clears history without deleting its local PDF', async () => {
    const started = await run(request('/api/scribd/run', { docs: [{ id: '100003', title: 'Slow book', pages: 10 }] }));
    expect(await started.json()).toMatchObject({ queued: 1, acceptedIds: ['100003'] });
    await vi.waitFor(async () => {
      const state = await (await status(request('/api/scribd/status'))).json();
      expect(state.items.find((item: { id: string }) => item.id === '100003')?.status).toBe('running');
    }, { timeout: 4000, interval: 40 });
    expect(await (await cancel(request('/api/scribd/reset', {}))).json()).toEqual({ requested: true });
    await vi.waitFor(async () => {
      const state = await (await status(request('/api/scribd/status'))).json();
      expect(state.active).toBe(0);
      expect(state.cancelled).toBe(true);
      expect(state.items.find((item: { id: string }) => item.id === '100003')).toMatchObject({ status: 'failed', error: 'Cancellation requested' });
    }, { timeout: 4000, interval: 40 });
    expect((await clear(request('/api/scribd/clear', {}))).status).toBe(200);
    expect(await (await status(request('/api/scribd/status'))).json()).toMatchObject({ items: [], state: 'idle' });
    expect((await file(request('/api/scribd/file?name=local.pdf'))).status).toBe(200);
  });

  it('clears waiting jobs while leaving the running job alone', async () => {
    const started = await run(request('/api/scribd/run', { docs: [
      { id: '100003', title: 'Slow book', pages: 10 },
      { id: '100004', title: 'Waiting book', pages: 1 },
    ] }));
    expect(await started.json()).toMatchObject({ queued: 2 });
    await vi.waitFor(async () => {
      const state = await (await status(request('/api/scribd/status'))).json();
      expect(state.items.find((item: { id: string }) => item.id === '100003')?.status).toBe('running');
      expect(state.items.find((item: { id: string }) => item.id === '100004')?.status).toBe('queued');
    }, { timeout: 4000, interval: 40 });
    const state = await (await clear(request('/api/scribd/clear', {}))).json();
    expect(state).toMatchObject({ state: 'running', active: 1, items: [{ id: '100003', status: 'running' }] });
    await cancel(request('/api/scribd/reset', {}));
    await vi.waitFor(async () => {
      expect((await (await status(request('/api/scribd/status'))).json()).active).toBe(0);
    }, { timeout: 4000, interval: 40 });
    await clear(request('/api/scribd/clear', {}));
  });

  it('returns a generic error when the upstream token is rejected', async () => {
    vi.stubEnv('SCRIBD_WEB_TOKEN', 'incorrect-secret');
    const response = await status(request('/api/scribd/status'));
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data).toEqual({ panelOnline: false, error: 'The Scribd server rejected its token. Ask the administrator to check SCRIBD_WEB_TOKEN.' });
    expect(JSON.stringify(data)).not.toContain('incorrect-secret');
  });
});
