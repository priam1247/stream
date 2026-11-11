// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { BotHeartbeatRecord, ConfirmedMemberLink, WhatsAppAccountStatus } from '../lib/types';

const state = vi.hoisted(() => ({
  signedIn: true, owner: 'member@example.com', cooldown: 0, reachable: true,
  accounts: [] as WhatsAppAccountStatus[] | undefined,
  heartbeat: null as BotHeartbeatRecord | null,
  links: [] as ConfirmedMemberLink[],
  cancellationSucceeds: true,
}));
const cancel = vi.hoisted(() => vi.fn(async () => state.cancellationSucceeds));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: async () => state.signedIn ? { user: { email: state.owner } } : null }));
vi.mock('../lib/activity', () => ({ recordActivity: async () => {}, maskedNumber: () => 'masked' }));
vi.mock('../lib/bot-proxy', () => ({
  normalizePhoneNumber: (value: unknown) => String(value || '').replace(/\D/g, ''),
  fetchLiveBotStatus: async () => ({ reachable: state.reachable, accounts: state.accounts }),
  requestWhitelistSync: async () => {},
}));
vi.mock('../lib/storage', () => ({
  getStoredWhatsAppUser: async () => ({ number: '265991234567', approval: 'pending', enabled: false, addedBy: 'member@example.com' }),
  sessionBackupClaim: () => ({ token: 'a'.repeat(64), identity: { key: 'claim', owner: 'member@example.com' } }),
  getPairCooldown: async () => state.cooldown,
  getBotHeartbeat: async () => state.heartbeat,
  listConfirmedMemberLinks: async () => state.links,
  cancelPendingWhatsAppUser: cancel,
  listStoredWhatsAppUsers: async () => [],
}));
import { POST } from '../app/api/member/cancel-pending/route';
const request = () => new NextRequest('http://localhost/api/member/cancel-pending', { method: 'POST', body: JSON.stringify({ number: '265991234567' }) });
beforeEach(() => { state.signedIn = true; state.owner = 'member@example.com'; state.cooldown = 0; state.reachable = true; state.accounts = []; state.heartbeat = null; state.links = []; state.cancellationSucceeds = true; cancel.mockClear(); });

describe('cancel an unlinked pending number', () => {
  it('requires the owning account', async () => {
    state.signedIn = false; expect((await POST(request())).status).toBe(401);
    state.signedIn = true; state.owner = 'other@example.com'; expect((await POST(request())).status).toBe(404);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('waits for the cooldown and refuses an offline or still-active attempt', async () => {
    state.cooldown = Date.now() + 1000; expect((await POST(request())).status).toBe(409);
    state.cooldown = 0; state.reachable = false; expect((await POST(request())).status).toBe(503);
    state.reachable = true; state.accounts = undefined; expect((await POST(request())).status).toBe(503);
    state.accounts = [{ number: '265991234567', state: 'awaiting_link', sessionId: 'b'.repeat(24), claimToken: 'a'.repeat(64) }];
    expect((await POST(request())).status).toBe(409);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('never deletes a confirmed link, even after the account reports a logout', async () => {
    state.accounts = [{ number: '265991234567', state: 'logged_out', sessionId: 'b'.repeat(24), claimToken: 'a'.repeat(64) }];
    state.links = [{ number: '265991234567', sessionId: 'b'.repeat(24), claimToken: 'a'.repeat(64), observedAt: Date.now() }];
    expect((await POST(request())).status).toBe(409);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('removes an expired, unlinked request only if its claim and cooldown still match', async () => {
    state.accounts = [{ number: '265991234567', state: 'expired', sessionId: 'b'.repeat(24), claimToken: 'a'.repeat(64) }];
    state.cancellationSucceeds = false;
    expect((await POST(request())).status).toBe(409);
    state.cancellationSucceeds = true;
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(cancel).toHaveBeenCalledWith('265991234567', 'member@example.com', 'claim');
  });
});
