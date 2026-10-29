// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WhatsAppAccountStatus } from '../lib/types';

const state = vi.hoisted(() => ({
  role: 'member' as 'member' | 'anonymous',
  accounts: undefined as WhatsAppAccountStatus[] | undefined,
  reachable: true,
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : {
    user: { email: 'member@example.com', memberAllowed: true, scribdAllowed: false },
  }),
}));
vi.mock('../lib/bot-proxy', () => ({
  getResolvedBotTarget: vi.fn(async () => ({ baseUrl: null, token: '', botEnabledForMembers: true })),
  fetchLiveBotStatus: vi.fn(async () => ({
    connectionMode: 'heartbeat', reachable: state.reachable, connected: state.reachable ? true : null,
    botNumber: '15550009999', accounts: state.accounts,
  })),
}));
vi.mock('../lib/storage', () => ({
  listStoredWhatsAppUsers: vi.fn(async () => [
    { number: '15550001111', enabled: true, addedBy: 'member@example.com' },
    { number: '15550002222', enabled: true, addedBy: 'other@example.com' },
  ]),
}));
vi.mock('../lib/sync-status', () => ({ whitelistSyncState: () => 'unknown' }));
import { GET } from '../app/api/member/status/route';

beforeEach(() => { state.role = 'member'; state.reachable = true; state.accounts = undefined; });
const request = () => new NextRequest('http://localhost/api/member/status');

describe('member WhatsApp status privacy', () => {
  it('requires authentication', async () => {
    state.role = 'anonymous';
    expect((await GET(request())).status).toBe(401);
  });

  it('returns only that member’s numbers and account states, without the primary number or administrator email', async () => {
    state.accounts = [
      { number: '15550009999', state: 'connected' },
      { number: '15550001111', state: 'awaiting_link' },
      { number: '15550002222', state: 'connected' },
    ];
    const body = await (await GET(request())).json();
    expect(body.botNumber).toBeNull();
    expect(body.adminEmail).toBe('');
    expect(body.numbers.map((n: { number: string }) => n.number)).toEqual(['15550001111']);
    expect(body.accounts).toEqual([{ number: '15550001111', state: 'awaiting_link' }]);
    expect(JSON.stringify(body)).not.toContain('15550009999');
    expect(JSON.stringify(body)).not.toContain('15550002222');
  });

  it('reports unknown account status when the server does not provide it', async () => {
    const body = await (await GET(request())).json();
    expect(body.accounts).toBeNull();
  });
});
