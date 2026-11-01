// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' | 'none', linked: false, memberAllowed: true, linkClaim: 'token-one' }));
const calls = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ number: '265991234567', label: 'Member', enabled: true, approval: 'approved' })),
  updatePolicy: vi.fn(async () => {}),
  supportMessages: vi.fn(async () => []),
  addMessage: vi.fn(async () => ({ id: 1, text: 'hello' })),
  listThreads: vi.fn(async () => [{ email: 'member@example.com', preview: 'hello', latestAt: 1, unread: 1 }]),
}));
vi.mock('../lib/auth-engine', () => ({ getAuthenticatedSession: vi.fn(async () => state.role === 'none' ? null : { user: { email: state.role === 'admin' ? 'admin@example.com' : 'member@example.com', isAdmin: state.role === 'admin', memberAllowed: state.memberAllowed } }) }));
vi.mock('../lib/activity', () => ({ maskedNumber: () => 'masked', recordActivity: vi.fn(async () => {}) }));
vi.mock('../lib/bot-proxy', () => ({
  normalizePhoneNumber: (value: unknown) => String(value || '').replace(/\D/g, ''),
  fetchLiveBotStatus: vi.fn(async () => ({ reachable: true, accounts: state.linked ? [{ number: '265991234567', state: 'paused', sessionId: 'a'.repeat(24), claimToken: state.linkClaim }] : [] })),
  syncNumberToLiveBot: vi.fn(async () => 'pending'),
}));
vi.mock('../lib/storage', () => ({
  getStoredWhatsAppUser: vi.fn(async () => ({ number: '265991234567', addedBy: 'member@example.com', approval: 'pending', enabled: false, pairAllowed: true })),
  resolvePendingWhatsAppUser: calls.resolve,
  sessionBackupClaim: () => ({ token: 'token-one', identity: { key: 'claim-one' } }),
  getBotHeartbeat: vi.fn(async () => ({ lastSeenAt: Date.now(), commandPolicyVersion: 'wrong' })),
  getMemberCommandPolicy: vi.fn(async () => ({ disabled: [], version: 'abc' })),
  setMemberCommandDisabled: calls.updatePolicy,
  listSupportThreads: calls.listThreads,
  listSupportMessages: calls.supportMessages,
  countMemberSupportUnread: vi.fn(async () => 2),
  addSupportMessage: calls.addMessage,
}));
import { POST as approval } from '../app/api/admin/approvals/route';
import { GET as commandsGet, PATCH as commandsPatch } from '../app/api/admin/commands/route';
import { GET as supportGet, POST as supportPost } from '../app/api/support/route';
const request = (url: string, body?: unknown, method = 'POST') => new NextRequest(`https://portal.example${url}`, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { state.role = 'member'; state.linked = false; state.memberAllowed = true; state.linkClaim = 'token-one'; Object.values(calls).forEach((mock) => mock.mockClear()); });

describe('new management routes', () => {
  it('requires a backend admin and a completed link before approving', async () => {
    expect((await approval(request('/api/admin/approvals', { number: '265991234567', action: 'approve' }))).status).toBe(403);
    state.role = 'none';
    expect((await approval(request('/api/admin/approvals', { number: '265991234567', action: 'approve' }))).status).toBe(401);
    state.role = 'admin';
    expect((await approval(request('/api/admin/approvals', { number: '265991234567', action: 'approve' }))).status).toBe(409);
    expect(calls.resolve).not.toHaveBeenCalled();
    state.linked = true; state.linkClaim = 'old-claim';
    expect((await approval(request('/api/admin/approvals', { number: '265991234567', action: 'approve' }))).status).toBe(409);
    state.linkClaim = 'token-one';
    expect((await approval(request('/api/admin/approvals', { number: '265991234567', action: 'approve' }))).status).toBe(200);
    expect(calls.resolve).toHaveBeenCalledWith('265991234567', 'member@example.com', true, 'claim-one');
  });
  it('only admins may change canonical member commands and a stale heartbeat stays pending', async () => {
    expect((await commandsGet(request('/api/admin/commands'))).status).toBe(403);
    expect((await commandsPatch(request('/api/admin/commands', { name: 'movie', disabled: true }, 'PATCH'))).status).toBe(403);
    state.role = 'admin';
    expect((await commandsPatch(request('/api/admin/commands', { name: 'film', disabled: true }, 'PATCH'))).status).toBe(400);
    const response = await commandsPatch(request('/api/admin/commands', { name: 'movie', disabled: true }, 'PATCH'));
    expect(response.status).toBe(200); expect((await response.json()).sync).toBe('pending');
    expect(calls.updatePolicy).toHaveBeenCalledWith('movie', true);
  });
  it('allows only admins to control remaining media commands and rejects retired ones', async () => {
    const patch = (name: string) => commandsPatch(request('/api/admin/commands', { name, disabled: true }, 'PATCH'));
    expect((await patch('reddit')).status).toBe(403);
    state.role = 'admin';
    expect((await patch('ig')).status).toBe(400);
    for (const name of ['reddit', 'tiktok', 'song', 'ytv']) {
      expect((await patch(name)).status).toBe(200);
      expect(calls.updatePolicy).toHaveBeenCalledWith(name, true);
    }
    for (const name of ['bilibili', 'audius', 'commons', 'deezer', 'youku']) {
      expect((await patch(name)).status).toBe(400);
    }
  });
  it('keeps support available to a restricted member and refreshes owner unread after reading', async () => {
    state.memberAllowed = false;
    expect((await supportGet(request('/api/support'))).status).toBe(200);
    expect((await supportPost(request('/api/support', { text: 'Please help' }))).status).toBe(201);
    expect(calls.addMessage).toHaveBeenCalledWith('member@example.com', 'member', 'Please help');
    state.role = 'admin';
    calls.listThreads.mockResolvedValueOnce([{ email: 'member@example.com', preview: 'hello', latestAt: 1, unread: 1 }])
      .mockResolvedValueOnce([{ email: 'member@example.com', preview: 'hello', latestAt: 1, unread: 0 }]);
    const response = await supportGet(request('/api/support?thread=member@example.com'));
    expect(await response.json()).toMatchObject({ unread: 0, threads: [{ unread: 0 }] });
  });
  it('restricts support threads to the authenticated member and checks owner replies', async () => {
    await supportGet(request('/api/support?thread=other@example.com'));
    expect(calls.supportMessages).toHaveBeenCalledWith('member@example.com', 'member');
    await supportPost(request('/api/support', { text: 'hello', thread: 'other@example.com' }));
    expect(calls.addMessage).toHaveBeenCalledWith('member@example.com', 'member', 'hello');
    state.role = 'admin';
    expect((await supportPost(request('/api/support', { text: 'hello', thread: 'other@example.com' }))).status).toBe(404);
    expect((await supportPost(request('/api/support', { text: 'hello', thread: 'member@example.com' }))).status).toBe(201);
    expect(calls.addMessage).toHaveBeenCalledWith('member@example.com', 'admin', 'hello');
    expect((await supportPost(request('/api/support', { text: 'x'.repeat(2001), thread: 'member@example.com' }))).status).toBe(400);
  });
});
