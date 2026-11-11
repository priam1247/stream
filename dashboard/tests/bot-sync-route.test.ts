// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ authorized: true }));
const calls = vi.hoisted(() => ({ claim: vi.fn(async () => [{ id: 'one', type: 'pair', payload: {}, expiresAt: Date.now() + 10_000 }]),
  complete: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}),
  release: vi.fn(async (_ids: string[]) => {}),
  snapshot: vi.fn(async () => ({ version: '0123456789abcdef', botEnabledForMembers: true, users: [] as { number: string; enabled: boolean; pairAllowed: boolean; claimId?: string; addedBy?: string; addedAt?: number; label?: string; approval?: string }[], numbers: [] as string[] })) }));
vi.mock('../lib/bot-sync-auth', () => ({ verifyBotSyncRequest: async () => state.authorized ? { ok: true, status: 200 } : { ok: false, status: 401, error: 'Unauthorized' } }));
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => 'test', recordRateLimitHit: () => {} }));
vi.mock('../lib/storage', () => ({ claimPendingBotCommands: calls.claim, completeBotCommand: calls.complete,
  saveBotHeartbeatIfNewer: calls.heartbeat, saveConfirmedMemberLinks: vi.fn(async () => {}), getBotHeartbeat: async () => null,
  computeWhitelistSnapshot: calls.snapshot, serializeWhitelistUsers: (users: unknown[]) => users,
  sessionBackupClaim: (user: { claimId?: string; addedBy?: string }) => ({ token: `${user.claimId}-${user.addedBy}`, identity: { key: user.claimId || '', owner: user.addedBy || '' } }),
  releaseClaimedBotCommands: calls.release,
  getNextBotPollMs: async () => 10_000 }));
import { POST } from '../app/api/bot/sync/route';
const request = (data: unknown) => new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body: JSON.stringify(data) });
beforeEach(() => { state.authorized = true; for (const fn of Object.values(calls)) fn.mockClear(); });

describe('single-service sync', () => {
  it('rejects unauthorized requests without mutating users, heartbeat or commands', async () => {
    state.authorized = false;
    expect((await POST(request({ connected: true, localUsers: [{ number: '15550001111' }] }))).status).toBe(401);
    expect(calls.heartbeat).not.toHaveBeenCalled(); expect(calls.claim).not.toHaveBeenCalled();
  });
  it('rejects unsupported old protocol fields without consuming commands or overwriting heartbeat', async () => {
    const response = await POST(request({ connected: true, failover: { role: 'botkeep' }, completedResults: [{ id: 'old', ok: true }] }));
    expect(response.status).toBe(409);
    expect(calls.heartbeat).not.toHaveBeenCalled();
    expect(calls.claim).not.toHaveBeenCalled(); expect(calls.complete).not.toHaveBeenCalled();
  });
  it('refreshes the permission snapshot after claiming commands, including a new member added during the tick', async () => {
    calls.snapshot.mockResolvedValueOnce({ version: '0123456789abcdef', botEnabledForMembers: true, users: [], numbers: [] })
      .mockResolvedValueOnce({ version: 'fedcba9876543210', botEnabledForMembers: true,
        users: [{ number: '15550001111', enabled: false, pairAllowed: true }], numbers: [] });
    const response = await POST(request({ connected: true, whitelistVersion: '0123456789abcdef' }));
    const body = await response.json();
    expect(body.whitelistChanged).toBe(true);
    expect(body.whitelistVersion).toBe('fedcba9876543210');
    expect(body.users).toEqual([{ number: '15550001111', enabled: false, pairAllowed: true }]);
    expect(body.commands).toHaveLength(1);
  });
  it('releases claimed commands when a fresh response snapshot cannot be built', async () => {
    calls.snapshot.mockResolvedValueOnce({ version: '0123456789abcdef', botEnabledForMembers: true, users: [], numbers: [] })
      .mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(POST(request({ connected: true }))).rejects.toThrow('Storage unavailable');
    expect(calls.release).toHaveBeenCalledWith(['one']);
  });
  it('ignores legacy localUsers and command-policy fields without importing or applying them', async () => {
    const response = await POST(request({ connected: true, whitelistVersion: '0123456789abcdef',
      localUsers: [{ number: '15550001111', label: 'Added via WhatsApp .allow' }], commandPolicyVersion: 'legacy' }));
    expect(response.status).toBe(200);
    expect(calls.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
    const body = await response.json();
    expect(body).not.toHaveProperty('users');
    expect(body).not.toHaveProperty('disabledMemberCommands');
  });
  it('reports counters, processes results and returns the full changed snapshot', async () => {
    calls.snapshot.mockResolvedValueOnce({ version: '0123456789abcdef', botEnabledForMembers: true, users: [], numbers: [] })
      .mockResolvedValueOnce({ version: '0123456789abcdef', botEnabledForMembers: true,
        users: [{ number: '15550001111', enabled: false, pairAllowed: true, claimId: 'stable', addedBy: 'member@example.com', addedAt: 1 }], numbers: [] });
    const response = await POST(request({ connected: true, botNumber: '15550009999', whitelistVersion: '',
      commandsTotal: 12, downloadsSuccess: 5, completedResults: [{ id: 'old', ok: true, result: { code: 'x' } }] }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, whitelistChanged: true, whitelistVersion: '0123456789abcdef', nextPollMs: 2000, commands: [{ id: 'one' }],
      users: [{ number: '15550001111', enabled: false, pairAllowed: true, claimId: 'stable' }] });
    expect(result).not.toHaveProperty('disabledMemberCommands');
    expect(result).not.toHaveProperty('commandPolicyVersion');
    expect(calls.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ connected: true, botNumber: '15550009999', commandsTotal: 12, downloadsSuccess: 5 }));
    expect(calls.complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', ok: true }));
    expect(calls.claim).toHaveBeenCalledOnce();
  });
});
