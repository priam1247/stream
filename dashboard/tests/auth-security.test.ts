// @vitest-environment node
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredPortalAccount } from '../lib/storage';

const db = vi.hoisted(() => ({
  account: null as StoredPortalAccount | null,
  upsert: vi.fn(),
}));
vi.mock('../lib/storage', () => ({
  findAccountByEmailOrUsername: vi.fn(async () => db.account),
  isMemberEmailAllowed: vi.fn(async () => true),
  isMemberScribdAllowed: vi.fn(async () => false),
  setMemberPermission: vi.fn(),
  upsertAccount: db.upsert,
}));
vi.mock('../lib/activity', () => ({ recordActivity: vi.fn() }));
vi.mock('../lib/email-service', () => ({
  isMailDeliveryConfigured: () => true,
  sendPasswordResetEmail: vi.fn(),
  sendVerificationEmail: vi.fn(async () => ({ delivered: true })),
}));

import { POST as verifyRoute } from '../app/api/auth/verify/route';
import { completePasswordReset, registerUserAccount } from '../lib/auth-engine';
import { SESSION_VERSION, signSessionJwt, verifySessionJwt } from '../lib/jwt';

function account(overrides: Partial<StoredPortalAccount> = {}): StoredPortalAccount {
  return {
    id: 1, email: 'owner@example.com', username: 'owner', name: 'Owner',
    passwordHash: 'not-used', isVerified: false, verificationCode: '123456',
    codeExpiresAt: new Date(Date.now() + 60_000).toISOString(), verificationAttempts: 0,
    resetCode: null, resetExpiresAt: null, resetAttempts: 0, createdAt: new Date().toISOString(),
    ...overrides,
  };
}
function request(code = '123456'): NextRequest {
  return new NextRequest('http://dashboard.test/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', code, password: 'ignored' }),
  });
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET_KEY', 'test-session-key-at-least-32-characters');
  db.account = account();
  db.upsert.mockReset().mockImplementation(async (value: StoredPortalAccount) => {
    db.account = value;
    return value;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('verification and session security', () => {
  it('never issues a token or cookie for an already verified account', async () => {
    db.account = account({ isVerified: true, verificationCode: null, codeExpiresAt: null });
    const response = await verifyRoute(request());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.token).toBeUndefined();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it('rejects an incorrect, missing-expiry or expired verification code', async () => {
    expect((await verifyRoute(request('999999'))).status).toBe(400);
    expect(db.account?.verificationAttempts).toBe(1);
    for (const codeExpiresAt of [null, 'not a date', new Date(Date.now() - 1000).toISOString()]) {
      db.account = account({ codeExpiresAt });
      const result = await verifyRoute(request());
      expect(result.status).toBe(400);
      expect(result.headers.get('set-cookie')).toBeNull();
    }
  });

  it('only issues a valid session after a valid unexpired one-time code', async () => {
    const response = await verifyRoute(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(verifySessionJwt(body.token)).toMatchObject({ sub: 'owner@example.com', ver: SESSION_VERSION });
    expect(response.headers.get('set-cookie')).toContain('zafar_session=');
    expect(db.account).toMatchObject({ isVerified: true, verificationCode: null, codeExpiresAt: null });
    const replay = await verifyRoute(request());
    expect(replay.status).toBe(400);
    expect(replay.headers.get('set-cookie')).toBeNull();
  });

  it('does not let another registration replace a pending account password', async () => {
    db.account = account({ passwordHash: await bcrypt.hash('original-password', 4) });
    await expect(registerUserAccount({ name: 'Other', email: 'owner@example.com', password: 'attacker-password' })).rejects.toThrow(/awaiting verification/i);
    expect(db.upsert).not.toHaveBeenCalled();
    await expect(registerUserAccount({ name: 'Owner', email: 'owner@example.com', password: 'original-password' })).resolves.toMatchObject({ email: 'owner@example.com' });
    expect(await bcrypt.compare('original-password', db.account!.passwordHash)).toBe(true);
  });

  it('creates a verified development account and reports no verification step when disabled', async () => {
    db.account = null;
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('EMAIL_VERIFICATION_REQUIRED', 'false');
    await expect(registerUserAccount({ name: 'Member', email: 'member@example.com', password: 'new-password' }))
      .resolves.toMatchObject({ requiresVerification: false });
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({ isVerified: true, verificationCode: null }));
  });

  it('requires email verification for registrations in production even if disabled in development', async () => {
    db.account = null;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_VERIFICATION_REQUIRED', 'false');
    await registerUserAccount({ name: 'Owner', email: 'owner@example.com', password: 'new-password' });
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({ isVerified: false, verificationCode: expect.stringMatching(/^\d{6}$/) }));
  });

  it('rejects reset codes with a missing, invalid or expired expiry', async () => {
    for (const resetExpiresAt of [null, 'invalid', new Date(Date.now() - 1000).toISOString()]) {
      db.account = account({ isVerified: true, resetCode: '123456', resetExpiresAt });
      await expect(completePasswordReset({ email: 'owner@example.com', code: '123456', newPassword: 'new-password' })).rejects.toThrow(/expired/i);
      expect(db.upsert).not.toHaveBeenCalled();
    }
  });

  it('rejects all legacy sessions while accepting newly issued sessions', () => {
    const secret = process.env.JWT_SECRET_KEY!;
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
    const legacy = `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
    expect(verifySessionJwt(legacy)).toBeNull();
    expect(verifySessionJwt(signSessionJwt({ sub: 'owner@example.com' }))).toMatchObject({ ver: SESSION_VERSION });
  });
});
