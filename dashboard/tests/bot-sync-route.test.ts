// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ authorized: true }));
const calls = vi.hoisted(() => ({ claim: vi.fn(async () => [{ id: 'one', type: 'pair', payload: {}, expiresAt: Date.now() + 10_000 }]),
  complete: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}), importUser: vi.fn(async () => true) }));
vi.mock('../lib/auth-engine', () => ({ getAdminEmail: () => 'owner@example.com' }));
vi.mock('../lib/bot-sync-auth', () => ({ verifyBotSyncRequest: async () => state.authorized ? { ok: true, status: 200 } : { ok: false, status: 401, error: 'Unauthorized' } }));
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => 'test', recordRateLimitHit: () => {} }));
vi.mock('../lib/storage', () => ({ claimPendingBotCommands: calls.claim, completeBotCommand: calls.complete,
  saveBotHeartbeat: calls.heartbeat, importLocalWhatsAppUser: calls.importUser, getBotHeartbeat: async () => null,
  computeWhitelistSnapshot: async () => ({ version: '0123456789abcdef', botEnabledForMembers: true, users: [], numbers: [] }),
  getMemberCommandPolicy: async () => ({ version: 'abcdef0123456789', disabled: [] }), getNextBotPollMs: async () => 10_000 }));
import { POST } from '../app/api/bot/sync/route';
const request = (data: unknown) => new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body: JSON.stringify(data) });
beforeEach(() => { state.authorized = true; for (const fn of Object.values(calls)) fn.mockClear(); });

describe('single-service sync', () => {
  it('rejects unauthorized requests without mutating users, heartbeat or commands', async () => {
    state.authorized = false;
    expect((await POST(request({ connected: true, localUsers: [{ number: '15550001111' }] }))).status).toBe(401);
    expect(calls.importUser).not.toHaveBeenCalled(); expect(calls.heartbeat).not.toHaveBeenCalled(); expect(calls.claim).not.toHaveBeenCalled();
  });
  it('rejects unsupported old protocol fields without consuming commands or overwriting heartbeat', async () => {
    const response = await POST(request({ connected: true, failover: { role: 'botkeep' }, completedResults: [{ id: 'old', ok: true }] }));
    expect(response.status).toBe(409);
    expect(calls.importUser).not.toHaveBeenCalled(); expect(calls.heartbeat).not.toHaveBeenCalled();
    expect(calls.claim).not.toHaveBeenCalled(); expect(calls.complete).not.toHaveBeenCalled();
  });
  it('imports allowlist entries safely, reports results, returns snapshots and claims commands', async () => {
    const response = await POST(request({ connected: true, botNumber: '15550009999',
      localUsers: [{ number: '+1 (555) 000-1111', label: 'Local' }, { number: 'bad' }], completedResults: [{ id: 'old', ok: true, result: { code: 'x' } }] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, whitelistChanged: true, whitelistVersion: '0123456789abcdef', nextPollMs: 2000, commands: [{ id: 'one' }] });
    expect(result).not.toHaveProperty('failover');
    expect(calls.importUser).toHaveBeenCalledOnce();
    expect(calls.importUser).toHaveBeenCalledWith('15550001111', 'Local', 'owner@example.com');
    expect(calls.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ connected: true, botNumber: '15550009999' }));
    expect(calls.complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', ok: true }));
    expect(calls.claim).toHaveBeenCalledOnce();
  });
});
