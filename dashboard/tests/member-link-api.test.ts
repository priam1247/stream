// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { BotCommandRecord, WhatsAppAccountStatus } from '../lib/types';

const state = vi.hoisted(() => ({
  signedIn: true,
  owner: 'member@example.com',
  storedOwner: 'member@example.com',
  claimKey: 'claim-one',
  reachable: true,
  account: { number: '265991234567', state: 'connected', sessionId: 'a'.repeat(24), claimToken: 'claim-token' } as WhatsAppAccountStatus | null,
  command: null as BotCommandRecord | null,
  cooldown: 0,
  pairFailure: false,
  unlinkPending: true,
}));
const mocks = vi.hoisted(() => ({
  deleted: vi.fn(async () => true),
  removed: vi.fn(async () => {}),
  saved: vi.fn(async () => {}),
  released: vi.fn(async () => { state.cooldown = 0; }),
  unlink: vi.fn(async () => state.unlinkPending ? { ok: true, status: 202, pending: true, requestId: 'unlink-1' } : { ok: true, status: 200 }),
  pair: vi.fn(async () => state.pairFailure ? { ok: false, status: 503, error: 'Offline' } :
    { ok: true, status: 200, code: 'TESTCODE', issuedAt: Date.now(), expiresInSeconds: 60 }),
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.signedIn ? { user: { email: state.owner, name: 'Member', isAdmin: false, memberAllowed: true } } : null),
}));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn(), maskedNumber: () => 'masked' }));
vi.mock('../lib/bot-proxy', () => ({
  normalizePhoneNumber: (value: unknown) => String(value || '').replace(/\D/g, ''),
  fetchLiveBotStatus: vi.fn(async () => ({ reachable: state.reachable, accounts: state.account ? [state.account] : [] })),
  requestLiveBotUnlink: mocks.unlink,
  requestWhitelistSync: mocks.removed,
  requestLiveBotPairingCode: mocks.pair,
  checkQueuedPairCommand: vi.fn(),
}));
vi.mock('../lib/storage', () => ({
  getBotConnectionConfig: vi.fn(async () => ({ botSyncToken: '', botEnabledForMembers: true })),
  getStoredWhatsAppUser: vi.fn(async () => ({ number: '265991234567', enabled: true, label: 'Member', addedBy: state.storedOwner, claimId: state.claimKey })),
  sessionBackupClaim: (user: { claimId: string }) => ({ token: user.claimId === 'claim-one' ? 'claim-token' : 'different-token', identity: { key: user.claimId } }),
  listStoredWhatsAppUsers: vi.fn(async () => []),
  getBotCommandById: vi.fn(async () => state.command),
  deleteWhatsAppUserIfOwned: mocks.deleted,
  claimPairCooldown: vi.fn(async (_number: string, now: number) => {
    if (state.cooldown > now) return { ok: false, retryAt: state.cooldown };
    state.cooldown = now + 180_000; return { ok: true, retryAt: state.cooldown };
  }),
  getPairCooldown: vi.fn(async () => state.cooldown),
  releasePairCooldown: mocks.released,
  getLatestPairCommand: vi.fn(async () => state.command),
  saveCompletedPairResult: mocks.saved,
}));
import { POST as startUnlink, GET as checkUnlink } from '../app/api/member/unlink/route';
import { POST as startPair, GET as checkPair } from '../app/api/member/pair/route';

const post = (path: string) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number: '265991234567' }),
});
const get = (path: string) => new NextRequest(`http://localhost${path}`);

beforeEach(() => {
  state.signedIn = true; state.owner = 'member@example.com'; state.storedOwner = state.owner; state.claimKey = 'claim-one';
  state.reachable = true; state.account = { number: '265991234567', state: 'connected', sessionId: 'a'.repeat(24), claimToken: 'claim-token' };
  state.cooldown = 0; state.pairFailure = false; state.unlinkPending = true;
  state.command = { id: 'unlink-1', type: 'unlink', payload: { number: '265991234567', sessionId: 'a'.repeat(24), claimKey: 'claim-one' },
    requestedBy: state.owner, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 90_000 };
  for (const mock of Object.values(mocks)) mock.mockClear();
});

describe('real unlink authorization and completion', () => {
  it('rejects signed-out users and numbers owned by someone else', async () => {
    state.signedIn = false;
    expect((await startUnlink(post('/api/member/unlink'))).status).toBe(401);
    state.signedIn = true; state.storedOwner = 'other@example.com';
    expect((await startUnlink(post('/api/member/unlink'))).status).toBe(404);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it('does not pretend to unlink an offline or primary/old service session', async () => {
    state.reachable = false;
    expect((await startUnlink(post('/api/member/unlink'))).status).toBe(503);
    state.reachable = true; state.account = { number: '265991234567', state: 'connected' };
    expect((await startUnlink(post('/api/member/unlink'))).status).toBe(409);
    expect(mocks.deleted).not.toHaveBeenCalled();
  });
  it('keeps approval until the matching bot generation confirms logout', async () => {
    const started = await startUnlink(post('/api/member/unlink'));
    expect(started.status).toBe(202);
    expect(mocks.unlink).toHaveBeenCalledWith('265991234567', 'a'.repeat(24), 'member@example.com', 'claim-one');
    expect((await checkUnlink(get('/api/member/unlink?requestId=unlink-1'))).status).toBe(202);
    expect(mocks.deleted).not.toHaveBeenCalled();
    state.command!.status = 'completed';
    state.command!.result = { number: '265991234567', sessionId: 'wrong', unlinked: true };
    expect((await checkUnlink(get('/api/member/unlink?requestId=unlink-1'))).status).toBe(502);
    state.command!.result = { number: '265991234567', sessionId: 'a'.repeat(24), unlinked: true };
    expect((await checkUnlink(get('/api/member/unlink?requestId=unlink-1'))).status).toBe(200);
    expect(mocks.deleted).toHaveBeenCalledWith('265991234567', 'member@example.com', 'claim-one');
  });
  it('does not unlink a socket belonging to an older claim', async () => {
    state.claimKey = 'claim-two';
    expect((await startUnlink(post('/api/member/unlink'))).status).toBe(409);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
  it('does not delete a newer claim of the same number and owner', async () => {
    state.claimKey = 'claim-two';
    state.command!.status = 'completed';
    state.command!.result = { number: '265991234567', sessionId: 'a'.repeat(24), unlinked: true };
    expect((await checkUnlink(get('/api/member/unlink?requestId=unlink-1'))).status).toBe(409);
    expect(mocks.deleted).not.toHaveBeenCalled();
  });
  it('rejects another requester and never removes a transferred number', async () => {
    state.command!.requestedBy = 'other@example.com';
    expect((await checkUnlink(get('/api/member/unlink?requestId=unlink-1'))).status).toBe(404);
    state.command!.requestedBy = state.owner; state.storedOwner = 'new@example.com';
    state.command!.status = 'completed'; state.command!.result = { number: '265991234567', sessionId: 'a'.repeat(24), unlinked: true };
    expect((await checkUnlink(get('/api/member/unlink?requestId=unlink-1'))).status).toBe(409);
    expect(mocks.deleted).not.toHaveBeenCalled();
  });
});

describe('three-minute pairing resend protection', () => {
  it('returns a 60-second code with a separate 180-second cooldown and rejects an early resend', async () => {
    const before = Date.now();
    const response = await startPair(post('/api/member/pair'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'TESTCODE', expiresInSeconds: 60 });
    expect(body.retryAt).toBeGreaterThanOrEqual(before + 180_000);
    expect(mocks.saved).toHaveBeenCalledWith(expect.objectContaining({ code: 'TESTCODE', expiresInSeconds: 60 }));
    const again = await startPair(post('/api/member/pair'));
    expect(again.status).toBe(429);
    expect((await again.json()).retryAt).toBe(body.retryAt);
    expect(mocks.pair).toHaveBeenCalledTimes(1);
  });
  it('releases the claimed cooldown when no request was accepted', async () => {
    state.pairFailure = true;
    expect((await startPair(post('/api/member/pair'))).status).toBe(503);
    expect(mocks.released).toHaveBeenCalled();
    expect(state.cooldown).toBe(0);
  });
  it('recovers request metadata only for the number’s current owner', async () => {
    state.cooldown = Date.now() + 100_000;
    state.command!.id = 'pair-1'; state.command!.type = 'pair';
    expect(await (await checkPair(get('/api/member/pair?number=265991234567'))).json()).toMatchObject({ requestId: 'pair-1', retryAt: state.cooldown });
    state.storedOwner = 'other@example.com';
    expect((await checkPair(get('/api/member/pair?number=265991234567'))).status).toBe(404);
  });
});
