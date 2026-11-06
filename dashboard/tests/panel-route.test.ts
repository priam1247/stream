import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  powerResult: { ok: false, status: 500, error: 'The request outcome is uncertain.' } as { ok: boolean; status: number; error?: string; serverId?: string; message?: string },
  config: { panelUrl: 'https://ignored.invalid', panelServerId: 'workload-1', panelApiKey: 'test-key-1234567890' },
  enqueue: vi.fn(async () => ({})), send: vi.fn(), save: vi.fn(), status: vi.fn(),
}));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: vi.fn(async () => ({ user: { isAdmin: true, email: 'owner@example.com' } })) }));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock('../lib/storage', () => ({
  getPanelConnectionConfig: vi.fn(async () => ({ ...state.config })),
  getBotHeartbeat: vi.fn(async () => ({ lastSeenAt: Date.now() })),
  enqueueBotCommand: state.enqueue,
  savePanelConnectionConfig: state.save,
}));
vi.mock('../lib/panel-client', () => ({ readPanelStatus: state.status, sendPanelPowerSignal: state.send }));
import { POST } from '../app/api/admin/panel/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/admin/panel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  state.enqueue.mockClear(); state.send.mockReset(); state.save.mockReset(); state.status.mockReset();
  state.config = { panelUrl: 'https://ignored.invalid', panelServerId: 'workload-1', panelApiKey: 'test-key-1234567890' };
  state.powerResult = { ok: false, status: 500, error: 'The request outcome is uncertain.' };
  state.send.mockImplementation(async () => state.powerResult);
  state.save.mockImplementation(async (patch: Partial<typeof state.config>) => ({ ...state.config, ...patch }));
  state.status.mockResolvedValue({ configured: true, reachable: true, state: 'running', error: null, checkedAt: Date.now() });
});

describe('owner HiddenCloud controls', () => {
  it('never assumes an action or sends power to an unconfirmed target', async () => {
    expect((await POST(request({ action: 'power' }))).status).toBe(400);
    expect((await POST(request({ action: 'power', signal: 'restart' }))).status).toBe(409);
    expect((await POST(request({ action: 'power', signal: 'restart', serverId: 'different-workload' }))).status).toBe(409);
    expect(state.send).not.toHaveBeenCalled(); expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('sends the confirmed snapshot and reports accepted rather than completed', async () => {
    state.powerResult = { ok: true, status: 202, serverId: 'workload-1', message: 'Accepted.' };
    const response = await POST(request({ action: 'power', signal: 'start', serverId: 'workload-1' }));
    expect(await response.json()).toMatchObject({ ok: true, via: 'hiddencloud-api', serverId: 'workload-1' });
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send).toHaveBeenCalledWith('start', state.config);
  });
  it('never enqueues a second action if the API outcome is uncertain or rate-limited', async () => {
    for (const code of [500, 502, 429]) {
      state.powerResult = { ok: false, status: code, error: 'Not confirmed.' };
      expect((await POST(request({ action: 'power', signal: 'restart', serverId: 'workload-1' }))).status).toBe(code);
    }
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('never queues a restart to an older bot after a rejection or when unconfigured', async () => {
    state.powerResult = { ok: false, status: 403, error: 'Rejected.' };
    expect((await POST(request({ action: 'power', signal: 'restart', serverId: 'workload-1' }))).status).toBe(403);
    state.config.panelApiKey = '';
    expect((await POST(request({ action: 'power', signal: 'restart', serverId: 'workload-1' }))).status).toBe(400);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('rejects old or arbitrary URLs and invalid IDs before saving or probing', async () => {
    expect((await POST(request({ action: 'save', panelUrl: 'https://old.example', panelServerId: 'workload-1', panelApiKey: 'test-key-1234567890' }))).status).toBe(400);
    expect((await POST(request({ action: 'save', panelServerId: '../wrong', panelApiKey: 'test-key-1234567890' }))).status).toBe(400);
    expect(state.save).not.toHaveBeenCalled(); expect(state.status).not.toHaveBeenCalled();
  });
  it('saves the explicitly provided target without discovering another server', async () => {
    const response = await POST(request({ action: 'save', panelServerId: 'workload-1', panelApiKey: 'test-key-1234567890' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, panelServerId: 'workload-1', verified: true });
    expect(state.save).toHaveBeenCalledWith({ panelServerId: 'workload-1', panelApiKey: 'test-key-1234567890' });
    expect(state.status).toHaveBeenCalledOnce();
  });
});
