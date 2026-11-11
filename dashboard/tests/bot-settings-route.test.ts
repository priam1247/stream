// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const calls = vi.hoisted(() => ({ save: vi.fn(async () => ({ botSyncToken: 'sync', botEnabledForMembers: true })) }));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: async () => ({ user: { isAdmin: true, email: 'owner@example.com' } }) }));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock('../lib/bot-proxy', () => ({ fetchLiveBotStatus: vi.fn(async () => ({ reachable: false, connectionMode: 'unconfigured' })) }));
vi.mock('../lib/storage', () => ({ saveBotConnectionConfig: calls.save, setFastPollWindow: vi.fn(async () => {}) }));
import { POST } from '../app/api/admin/settings/route';
const request = (body: unknown) => new NextRequest('https://dashboard.example/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => calls.save.mockClear());

it('rejects a stale settings page that still sends an inbound bridge', async () => {
  for (const body of [
    { botApiUrl: 'https://old-host.invalid' },
    { botAdminToken: 'old-token' },
    { bridgeTarget: 'botkeep', botApiUrl: 'https://botkeep-service.example' },
  ]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect(calls.save).not.toHaveBeenCalled();
});

it('saves the sync token and the member-linking switch only', async () => {
  const res = await POST(request({ botSyncToken: 'new-sync-token' }));
  expect(res.status).toBe(200);
  expect(calls.save).toHaveBeenCalledWith({ botSyncToken: 'new-sync-token', botEnabledForMembers: undefined });
  expect(await res.json()).toMatchObject({ ok: true, hasBotSyncToken: true, botEnabledForMembers: true });

  expect((await POST(request({ botEnabledForMembers: false }))).status).toBe(200);
  expect(calls.save).toHaveBeenLastCalledWith({ botSyncToken: undefined, botEnabledForMembers: false });
});

it('never echoes a masked placeholder back into storage', async () => {
  await POST(request({ botSyncToken: '••••••••' }));
  expect(calls.save).toHaveBeenCalledWith({ botSyncToken: undefined, botEnabledForMembers: undefined });
});
