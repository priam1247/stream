// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ durable: true, allowed: true, claim: 'claim-one', revoked: false, auth: true, outage: false }));
const calls = vi.hoisted(() => ({ put: vi.fn(async () => 2), revoke: vi.fn(async () => {}) }));
vi.mock('../lib/bot-sync-auth', () => ({ verifyBotSyncRequest: vi.fn(async () => state.auth ? { ok: true, status: 200 } : { ok: false, status: 401, error: 'Unauthorized' }) }));
vi.mock('../lib/storage', () => ({
  isUsingCloudflareD1: vi.fn(async () => state.durable),
  getStoredWhatsAppUser: vi.fn(async () => ({ enabled: state.allowed, pairAllowed: false, addedBy: 'member@example.com', claimId: state.claim })),
  listSessionBackupMetadata: vi.fn(async () => { if (state.outage) throw new Error('private database error'); return []; }),
  getSessionBackup: vi.fn(async () => ({ slot: 'linked:265991234567', claimToken: crypto.createHash('sha256').update(JSON.stringify(['claim-one', 'member@example.com'])).digest('hex'), revoked: state.revoked, ciphertext: 'v1:abc:abc:abc', revision: 1, generation: 'a'.repeat(24) })),
  getEligibleSessionBackup: vi.fn(async (_slot: string, token: string) => !state.revoked && token === crypto.createHash('sha256').update(JSON.stringify(['claim-one', 'member@example.com'])).digest('hex') ? ({ slot: 'linked:265991234567', claimToken: token, revoked: false, ciphertext: 'v1:abc:abc:abc', revision: 1, generation: 'a'.repeat(24) }) : null),
  sessionBackupClaim: (user: { claimId: string; addedBy: string }) => ({ token: crypto.createHash('sha256').update(JSON.stringify([user.claimId, user.addedBy])).digest('hex'), identity: { key: user.claimId, owner: user.addedBy } }),
  putSessionBackup: calls.put,
  revokeSessionBackup: calls.revoke,
}));
import { POST } from '../app/api/bot/session-backups/route';
const request = (body: unknown, signed = true) => new NextRequest('https://portal.example/api/bot/session-backups', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(signed ? { 'x-bot-timestamp': '1', 'x-bot-nonce': 'nonce-value', 'x-bot-signature': 'signature' } : {}) }, body: JSON.stringify(body),
});
beforeEach(() => { Object.assign(state, { durable: true, allowed: true, claim: 'claim-one', revoked: false, auth: true, outage: false }); calls.put.mockClear(); calls.revoke.mockClear(); });

describe('encrypted backup transport', () => {
  it('requires a signed authorized service request and durable D1', async () => {
    expect((await POST(request({ action: 'list' }, false))).status).toBe(401);
    state.auth = false; expect((await POST(request({ action: 'list' }))).status).toBe(401);
    state.auth = true; state.durable = false; expect((await POST(request({ action: 'list' }))).status).toBe(503);
  });
  it('returns a generic unavailable error rather than an empty backup on storage failure', async () => {
    state.outage = true;
    const response = await POST(request({ action: 'list' }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private database error');
    expect((await POST(request(null))).status).toBe(400);
  });
  it('does not restore revoked, blocked or transferred sessions', async () => {
    const get = () => POST(request({ action: 'get', slot: 'linked:265991234567' }));
    expect((await get()).status).toBe(200);
    state.revoked = true; expect((await get()).status).toBe(404);
    state.revoked = false; state.allowed = false; expect((await get()).status).toBe(403);
    state.allowed = true; state.claim = 'claim-two'; expect((await get()).status).toBe(404);
  });
  it('accepts only bounded encrypted blobs and uses compare-and-swap revisions', async () => {
    const body = { action: 'put', slot: 'linked:265991234567', generation: 'a'.repeat(24), revision: 1, claimToken: crypto.createHash('sha256').update(JSON.stringify(['claim-one', 'member@example.com'])).digest('hex'), ciphertext: 'v1:YWJj:YWJj:YWJj' };
    expect((await POST(request(body))).status).toBe(200);
    expect(calls.put).toHaveBeenCalledWith(body.slot, body.generation, expect.any(String), body.ciphertext, 1, { key: 'claim-one', owner: 'member@example.com' });
    expect((await POST(request({ ...body, ciphertext: '{"registered":true}' }))).status).toBe(400);
    expect((await POST(request({ ...body, ciphertext: `v1:${'a'.repeat(1_100_000)}` }))).status).toBe(413);
    expect((await POST(request({ ...body, slot: '../escape' }))).status).toBe(400);
  });
});
