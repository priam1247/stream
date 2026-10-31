// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const calls = vi.hoisted(() => ({ save: vi.fn(async () => ({ botApiUrl: '', botAdminToken: '', botSyncToken: 'sync', botEnabledForMembers: true })) }));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: async () => ({ user: { isAdmin: true, email: 'owner@example.com' } }) }));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock('../lib/bot-proxy', () => ({ parseAndValidateBotUrl: (url: string) => ({ baseUrl: url || null, hostLabel: null }), fetchLiveBotStatus: vi.fn(async () => ({ reachable: false })) }));
vi.mock('../lib/storage', () => ({ saveBotConnectionConfig: calls.save, setFastPollWindow: vi.fn(async () => {}) }));
import { POST } from '../app/api/admin/settings/route';
const request = (body: unknown) => new NextRequest('https://dashboard.example/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => calls.save.mockClear());
it('does not reactivate an old direct bridge from a stale settings page', async () => {
  expect((await POST(request({ botApiUrl: 'https://old-host.invalid', botAdminToken: 'old-token' }))).status).toBe(400);
  expect(calls.save).not.toHaveBeenCalled();
});
it('allows an explicitly selected Botkeep bridge and member-only changes', async () => {
  expect((await POST(request({ bridgeTarget: 'botkeep', botApiUrl: 'https://botkeep-service.example', botAdminToken: 'new-token' }))).status).toBe(200);
  expect(calls.save).toHaveBeenCalledWith(expect.objectContaining({ botApiUrl: 'https://botkeep-service.example', botAdminToken: 'new-token' }));
  expect((await POST(request({ botEnabledForMembers: false }))).status).toBe(200);
});
