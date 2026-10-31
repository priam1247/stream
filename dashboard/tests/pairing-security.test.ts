import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { BotCommandRecord } from '../lib/types';

const state = vi.hoisted(() => ({
  role: 'member' as 'member' | 'blocked' | 'anonymous',
  command: null as BotCommandRecord | null,
  stored: null as { number: string; label: string; enabled: boolean; addedBy: string } | null,
  linkingEnabled: true,
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : {
    user: { email: 'member@example.com', name: 'Member', isAdmin: false, memberAllowed: state.role === 'member' },
  }),
  getAdminEmail: () => 'owner@example.com',
}));
vi.mock('../lib/storage', () => ({
  getBotCommandById: vi.fn(async () => state.command),
  getStoredWhatsAppUser: vi.fn(async () => state.stored),
  getBotConnectionConfig: vi.fn(async () => ({ botApiUrl: '', botAdminToken: '', botSyncToken: '', botEnabledForMembers: state.linkingEnabled })),
}));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn(), maskedNumber: () => 'masked' }));
import { GET, POST } from '../app/api/member/pair/route';

const request = () => new NextRequest('http://localhost/api/member/pair?requestId=request-1');

beforeEach(() => {
  state.role = 'member';
  state.linkingEnabled = true;
  state.stored = { number: '265991234567', label: 'Mobile', enabled: true, addedBy: 'member@example.com' };
  state.command = {
    id: 'request-1', type: 'pair', payload: { number: '265991234567' }, status: 'completed',
    result: { code: 'TESTCODE', expiresInSeconds: 60 }, requestedBy: 'member@example.com',
    createdAt: Date.now() - 10_000, expiresAt: Date.now() + 50_000,
  };
});

describe('pairing result ownership and expiry', () => {
  it('rejects anonymous and blocked accounts', async () => {
    state.role = 'anonymous';
    expect((await GET(request())).status).toBe(401);
    state.role = 'blocked';
    expect((await GET(request())).status).toBe(403);
  });

  it('never returns another member’s queued result, even with the request ID', async () => {
    state.command!.requestedBy = 'other@example.com';
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('TESTCODE');
  });

  it('uses the original request time rather than extending code validity on each poll', async () => {
    const created = state.command!.createdAt;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ code: 'TESTCODE', issuedAt: created, expiresInSeconds: 60 });
  });

  it('refuses a conservatively expired code', async () => {
    state.command!.createdAt = Date.now() - 61_000;
    const response = await GET(request());
    expect(response.status).toBe(410);
    expect(JSON.stringify(await response.json())).not.toContain('TESTCODE');
  });

  it('uses the fixed service issuance time without resetting the countdown on later polls', async () => {
    const issuedAt = state.command!.createdAt + 5000;
    state.command!.result!.issuedAt = issuedAt;
    state.command!.result!._dashboardReceivedAt = Date.now();
    const first = await (await GET(request())).json();
    const second = await (await GET(request())).json();
    expect(first.issuedAt).toBe(issuedAt);
    expect(second.issuedAt).toBe(issuedAt);
  });

  it('falls back conservatively for a future or implausible timestamp', async () => {
    state.command!.result!.issuedAt = Date.now() + 60_000;
    expect((await (await GET(request())).json()).issuedAt).toBe(state.command!.createdAt);
  });

  it('does not disclose codes after approval is revoked, removed or transferred', async () => {
    for (const change of ['disabled', 'removed', 'transferred'] as const) {
      state.stored = change === 'removed' ? null : {
        number: '265991234567', label: 'Mobile', enabled: change !== 'disabled',
        addedBy: change === 'transferred' ? 'other@example.com' : 'member@example.com',
      };
      const response = await GET(request());
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain('TESTCODE');
    }
  });

  it('does not expose non-pair commands', async () => {
    state.command!.type = 'restart';
    expect((await GET(request())).status).toBe(404);
  });
});

const post = (number = '265991234567') => new NextRequest('http://localhost/api/member/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }),
});

describe('pairing request permissions', () => {
  it('denies signed-out or blocked users and honors the linking pause', async () => {
    state.role = 'anonymous';
    expect((await POST(post())).status).toBe(401);
    state.role = 'blocked';
    expect((await POST(post())).status).toBe(403);
    state.role = 'member';
    state.linkingEnabled = false;
    expect((await POST(post())).status).toBe(403);
  });

  it('requires an enabled number owned by the requesting member', async () => {
    state.stored!.addedBy = 'another@example.com';
    expect((await POST(post())).status).toBe(403);
    state.stored!.addedBy = 'member@example.com';
    state.stored!.enabled = false;
    expect((await POST(post())).status).toBe(403);
    state.stored = null;
    expect((await POST(post())).status).toBe(403);
  });
});
