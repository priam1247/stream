import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  powerResult: { ok: false, status: 500, error: 'The request outcome is uncertain.' },
  enqueue: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: vi.fn(async () => ({ user: { isAdmin: true, email: 'owner@example.com' } })) }));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn() }));
vi.mock('../lib/storage', () => ({
  getPanelConnectionConfig: vi.fn(async () => ({ panelApiKey: 'secret' })),
  getBotHeartbeat: vi.fn(async () => ({ lastSeenAt: Date.now() })),
  enqueueBotCommand: state.enqueue,
  savePanelConnectionConfig: vi.fn(),
}));
vi.mock('../lib/panel-client', () => ({
  discoverPanelServers: vi.fn(), normalizePanelBaseUrl: vi.fn(),
  sendPanelPowerSignal: state.send,
}));
import { POST } from '../app/api/admin/panel/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/admin/panel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  state.enqueue.mockReset();
  state.send.mockReset();
  state.send.mockImplementation(async () => state.powerResult);
});

describe('power requests', () => {
  it('never assumes restart when no signal was provided', async () => {
    const response = await POST(request({ action: 'power' }));
    expect(response.status).toBe(400);
    expect(state.send).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('does not enqueue a second restart if the panel outcome is uncertain', async () => {
    state.powerResult = { ok: false, status: 500, error: 'The request outcome is uncertain.' };
    const response = await POST(request({ action: 'power', signal: 'restart' }));
    expect(response.status).toBe(500);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('can fall back to the bot when the panel explicitly rejects the request', async () => {
    state.powerResult = { ok: false, status: 403, error: 'Panel rejected the key.' };
    const response = await POST(request({ action: 'power', signal: 'restart' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ via: 'bot-queue' });
    expect(state.enqueue).toHaveBeenCalledOnce();
  });
});
