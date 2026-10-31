// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ enabled: true }));
const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => ({ botApiUrl: 'https://old-botkeep.example', botAdminToken: 'old-key', botSyncToken: 'test', botEnabledForMembers: true })),
  probe: vi.fn(async () => ({ reachable: false })),
}));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: async () => ({ user: { isAdmin: true, email: 'owner@example.com' } }) }));
vi.mock('../lib/activity', () => ({ recordActivity: async () => {} }));
vi.mock('../lib/storage', () => ({ getFailoverStatus: async () => ({ enabled: state.enabled }), saveBotConnectionConfig: mocks.save, setFastPollWindow: async () => {} }));
vi.mock('../lib/bot-proxy', () => ({
  fetchLiveBotStatus: mocks.probe,
  parseAndValidateBotUrl: (url: string) => ({ baseUrl: url || null, hostLabel: null }),
}));
import { POST } from '../app/api/admin/settings/route';

const request = (body: unknown) => new NextRequest('https://dashboard.example/api/admin/settings', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => { state.enabled = true; vi.clearAllMocks(); });

it('refuses a direct host URL while failover is active', async () => {
  expect((await POST(request({ botApiUrl: 'https://old-botkeep.example' }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.probe).not.toHaveBeenCalled();
});

it('preserves old direct settings without probing or exposing them while saving sync', async () => {
  const response = await POST(request({ botApiUrl: '', botAdminToken: '', botSyncToken: 'test' }));
  expect(response.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ botApiUrl: undefined, botAdminToken: undefined, botSyncToken: 'test' }));
  expect(mocks.probe).toHaveBeenCalledWith();
  expect(await response.json()).toMatchObject({ botApiUrl: '', hasBotToken: false });
});
