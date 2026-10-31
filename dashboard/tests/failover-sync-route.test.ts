// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  enabled: true,
  lease: { role: 'xs', instance: 'a'.repeat(32), granted: true, epoch: 4, ttlMs: 30_000 } as Record<string, unknown>,
  unavailable: false,
}));
const mocks = vi.hoisted(() => ({
  claimLease: vi.fn(async () => { if (state.unavailable) throw new Error('D1 down'); return state.lease; }),
  claimCommands: vi.fn(async () => [{ id: 'one', type: 'restart', payload: {}, expiresAt: Date.now() + 10_000 }]),
  complete: vi.fn(async () => {}),
  heartbeat: vi.fn(async () => {}),
  importUser: vi.fn(async () => true),
  legacyImport: vi.fn(async () => []),
}));
vi.mock('../lib/auth-engine', () => ({ getAdminEmail: () => 'owner@example.com' }));
vi.mock('../lib/bot-sync-auth', () => ({ verifyBotSyncRequest: async () => ({ ok: true, status: 200 }) }));
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => 'test', recordRateLimitHit: () => {} }));
vi.mock('../lib/storage', () => ({
  claimFailoverLease: mocks.claimLease,
  claimPendingBotCommands: mocks.claimCommands,
  completeBotCommand: mocks.complete,
  saveBotHeartbeat: mocks.heartbeat,
  importLocalUserForLease: mocks.importUser,
  saveStoredWhatsAppUser: mocks.legacyImport,
  getFailoverStatus: async () => ({ enabled: state.enabled }),
  getBotHeartbeat: async () => null,
  getStoredWhatsAppUser: async () => null,
  computeWhitelistSnapshot: async () => ({ version: '0123456789abcdef', botEnabledForMembers: true, users: [], numbers: [] }),
  getMemberCommandPolicy: async () => ({ version: 'abcdef0123456789', disabled: [] }),
  getNextBotPollMs: async () => 10_000,
}));

import { POST } from '../app/api/bot/sync/route';

function request(body: Record<string, unknown>, signed = true) {
  return new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST',
    headers: signed ? { 'x-bot-timestamp': '1', 'x-bot-nonce': 'test-nonce', 'x-bot-signature': 'signature' } : {},
    body: JSON.stringify(body),
  });
}
const identity = { role: 'xs', instance: 'a'.repeat(32), epoch: 4, primaryConnected: true, deviceFingerprint: '1'.repeat(64) };
const fence = { role: 'xs', instance: 'a'.repeat(32), epoch: 4 };

beforeEach(() => {
  state.enabled = true;
  state.unavailable = false;
  state.lease = { role: 'xs', instance: 'a'.repeat(32), granted: true, epoch: 4, ttlMs: 30_000 };
  for (const fn of Object.values(mocks)) fn.mockClear();
});

describe('signed failover sync routing', () => {
  it('rejects unsigned, malformed and legacy requests once failover is enabled', async () => {
    expect((await POST(request({ connected: true, failover: identity }, false))).status).toBe(401);
    expect((await POST(request({ connected: true, failover: { role: 'xs', instance: 'bad' } }))).status).toBe(400);
    expect((await POST(request({ connected: true }))).status).toBe(409);
    expect(mocks.claimLease).not.toHaveBeenCalled();
  });

  it('uses primary-device health rather than the presence of an unrelated member session', async () => {
    await POST(request({ connected: true, failover: { ...identity, primaryConnected: false } }));
    expect(mocks.claimLease).toHaveBeenCalledWith({ role: 'xs', instance: 'a'.repeat(32) },
      { connected: false, accountNumber: '', deviceFingerprint: '1'.repeat(64), version: '' });
  });

  it('fails closed if D1 coordination is unavailable', async () => {
    state.unavailable = true;
    expect((await POST(request({ connected: true, failover: identity }))).status).toBe(503);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.claimCommands).not.toHaveBeenCalled();
  });

  it('only sends permission snapshots to a standby, without processing commands or local users', async () => {
    state.lease = { ...identity, granted: false };
    const res = await POST(request({ connected: true, failover: identity, localUsers: [{ number: '15550001111' }], completedResults: [{ id: 'old', ok: true }] }));
    const body = await res.json();
    expect(body.failover.granted).toBe(false);
    expect(body.commands).toEqual([]);
    expect(body.whitelistChanged).toBe(true);
    expect(body.nextPollMs).toBe(5_000);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.claimCommands).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.importUser).not.toHaveBeenCalled();
  });

  it('fences active queue and heartbeat operations and ignores results from an older epoch', async () => {
    const body = { connected: true, failover: { ...identity, epoch: 3 }, localUsers: [{ number: '15550001111' }], completedResults: [{ id: 'old', ok: true }] };
    const res = await POST(request(body));
    const result = await res.json();
    expect(result.failover).toMatchObject({ granted: true, epoch: 4 });
    expect(result.commands).toHaveLength(1);
    expect(mocks.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ failover: { role: 'xs', epoch: 4 } }), fence);
    expect(mocks.claimCommands).toHaveBeenCalledWith(fence);
    expect(mocks.importUser).toHaveBeenCalledWith('15550001111', expect.any(String), 'owner@example.com', fence);
    expect(mocks.complete).not.toHaveBeenCalled();
    await POST(request({ connected: true, failover: identity, completedResults: [{ id: 'current', ok: true }] }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'current', ok: true }), fence);
  });
});
