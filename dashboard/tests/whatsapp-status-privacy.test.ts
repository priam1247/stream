// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WhatsAppAccountStatus } from '../lib/types';

const state = vi.hoisted(() => ({
  role: 'member' as 'member' | 'anonymous',
  accounts: undefined as WhatsAppAccountStatus[] | undefined,
  reachable: true,
  mode: 'heartbeat' as 'heartbeat' | 'direct',
  persisted: [] as import('../lib/types').ConfirmedMemberLink[],
  heartbeat: null as import('../lib/types').BotHeartbeatRecord | null,
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : {
    user: { email: 'member@example.com', memberAllowed: true },
  }),
}));
vi.mock('../lib/bot-proxy', () => ({
  getResolvedBotTarget: vi.fn(async () => ({ baseUrl: state.mode === 'direct' ? 'https://service.example' : null, token: state.mode === 'direct' ? 'test' : '', botEnabledForMembers: true })),
  fetchLiveBotStatus: vi.fn(async () => ({
    connectionMode: state.mode, reachable: state.reachable, connected: state.reachable ? true : null,
    botNumber: '15550009999', accounts: state.accounts, commandsTotal: 999, downloadsSuccess: 888,
  })),
}));
vi.mock('../lib/storage', () => ({
  sessionBackupClaim: () => ({ token: 'a'.repeat(64) }),
  getBotHeartbeat: vi.fn(async () => state.heartbeat),
  listConfirmedMemberLinks: vi.fn(async () => state.persisted),
  saveConfirmedMemberLinks: vi.fn(async (links: import('../lib/types').ConfirmedMemberLink[]) => { if (links.length) state.persisted = links; }),
  getMemberCommandPolicy: vi.fn(async () => ({ disabled: [], version: 'test' })),
  listStoredWhatsAppUsers: vi.fn(async () => [
    { number: '15550001111', enabled: true, addedBy: 'member@example.com' },
    { number: '15550002222', enabled: true, addedBy: 'other@example.com' },
  ]),
}));
vi.mock('../lib/sync-status', () => ({ whitelistSyncState: () => 'unknown' }));
import { GET } from '../app/api/member/status/route';

beforeEach(() => { state.role = 'member'; state.reachable = true; state.mode = 'heartbeat'; state.persisted = []; state.accounts = undefined; state.heartbeat = null; });
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
    expect(body.commandsTotal).toBeNull();
    expect(body.downloadsSuccess).toBeNull();
    expect(body.numbers.map((n: { number: string }) => n.number)).toEqual(['15550001111']);
    expect(body.accounts).toEqual([{ number: '15550001111', state: 'awaiting_link' }]);
    expect(JSON.stringify(body)).not.toContain('15550009999');
    expect(JSON.stringify(body)).not.toContain('15550002222');
  });

  it('hides a previous owner’s session and strips internal ownership tokens', async () => {
    state.accounts = [{ number: '15550001111', state: 'paused', sessionId: 'b'.repeat(24), claimToken: 'c'.repeat(64) }];
    expect((await (await GET(request())).json()).accounts).toEqual([]);
    state.accounts = [{ number: '15550001111', state: 'paused', sessionId: 'b'.repeat(24), claimToken: 'a'.repeat(64) }];
    const body = await (await GET(request())).json();
    expect(body.accounts).toEqual([{ number: '15550001111', state: 'paused', sessionId: 'b'.repeat(24) }]);
    expect(JSON.stringify(body)).not.toContain('a'.repeat(64));
  });
  it('preserves a direct-mode link through an outage without creating a heartbeat or exposing its claim', async () => {
    state.mode = 'direct';
    state.accounts = [{ number: '15550001111', state: 'paused', sessionId: 'b'.repeat(24), claimToken: 'a'.repeat(64), linkedAt: Date.now() - 60_000 }];
    const live = await (await GET(request())).json();
    expect(live.confirmedLinks).toHaveLength(1);
    expect(state.persisted).toHaveLength(1);
    expect(state.heartbeat).toBeNull();
    state.reachable = false; state.accounts = undefined;
    const offline = await (await GET(request())).json();
    expect(offline.botReachable).toBe(false);
    expect(offline.confirmedLinks).toEqual(live.confirmedLinks);
    expect(JSON.stringify(offline)).not.toContain('a'.repeat(64));
  });
  it('reports unknown account status when the server does not provide it', async () => {
    const body = await (await GET(request())).json();
    expect(body.accounts).toBeNull();
  });
});
