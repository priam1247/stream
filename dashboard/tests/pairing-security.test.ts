import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { BotCommandRecord } from '../lib/types';

const state = vi.hoisted(() => ({
  role: 'member' as 'member' | 'blocked' | 'anonymous',
  command: null as BotCommandRecord | null,
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : {
    user: { email: 'member@example.com', name: 'Member', isAdmin: false, memberAllowed: state.role === 'member' },
  }),
  getAdminEmail: () => 'owner@example.com',
}));
vi.mock('../lib/storage', () => ({
  getBotCommandById: vi.fn(async () => state.command),
  getStoredWhatsAppUser: vi.fn(),
}));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn(), maskedNumber: () => 'masked' }));
import { GET } from '../app/api/member/pair/route';

const request = () => new NextRequest('http://localhost/api/member/pair?requestId=request-1');

beforeEach(() => {
  state.role = 'member';
  state.command = {
    id: 'request-1', type: 'pair', payload: {}, status: 'completed',
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
    expect(await response.json()).toMatchObject({ code: 'TESTCODE', issuedAt: created, expiresInSeconds: 60 });
  });

  it('refuses a conservatively expired code', async () => {
    state.command!.createdAt = Date.now() - 61_000;
    const response = await GET(request());
    expect(response.status).toBe(410);
    expect(JSON.stringify(await response.json())).not.toContain('TESTCODE');
  });

  it('does not expose non-pair commands', async () => {
    state.command!.type = 'restart';
    expect((await GET(request())).status).toBe(404);
  });
});
