import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' | 'anonymous' }));
const store = vi.hoisted(() => ({
  setGrant: vi.fn(),
  listMembers: vi.fn(async () => [{ email: 'member@example.com', allowed: true, scribdAllowed: false }]),
  listActivity: vi.fn(async () => [{ id: '1', category: 'members', action: 'Member allowed' }]),
  record: vi.fn(),
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : { user: { isAdmin: state.role === 'admin', email: `${state.role}@example.com` } }),
  isAdminEmail: (email: string) => email === 'admin@example.com',
}));
vi.mock('../lib/storage', () => ({
  setMemberScribdAllowed: store.setGrant,
  listAllMembers: store.listMembers,
  listRecentActivity: store.listActivity,
  isUsingCloudflareD1: vi.fn(async () => true),
}));
vi.mock('../lib/activity', () => ({ recordActivity: store.record }));
import { PATCH as setScribdAccess } from '../app/api/admin/members/scribd/route';
import { GET as getActivity } from '../app/api/admin/activity/route';

function req(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, body === undefined ? {} : {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.role = 'admin';
  vi.clearAllMocks();
});

describe('owner controls', () => {
  it('limits activity and Scribd access changes to signed-in administrators', async () => {
    for (const role of ['anonymous', 'member'] as const) {
      state.role = role;
      const expected = role === 'anonymous' ? 401 : 403;
      expect((await getActivity(req('/api/admin/activity'))).status).toBe(expected);
      expect((await setScribdAccess(req('/api/admin/members/scribd', { email: 'member@example.com', allowed: true }))).status).toBe(expected);
    }
    expect(store.setGrant).not.toHaveBeenCalled();
    expect(store.listActivity).not.toHaveBeenCalled();
  });

  it('requires a real member, an explicit boolean, and never changes owner access', async () => {
    expect((await setScribdAccess(req('/api/admin/members/scribd', { email: 'member@example.com', allowed: 'true' }))).status).toBe(400);
    expect((await setScribdAccess(req('/api/admin/members/scribd', { email: 'admin@example.com', allowed: false }))).status).toBe(400);
    expect((await setScribdAccess(req('/api/admin/members/scribd', { email: 'missing@example.com', allowed: true }))).status).toBe(404);
    expect(store.setGrant).not.toHaveBeenCalled();
  });

  it('grants and revokes an individual member and records the action', async () => {
    const grant = await setScribdAccess(req('/api/admin/members/scribd', { email: 'MEMBER@example.com ', allowed: true }));
    expect(grant.status).toBe(200);
    expect(store.setGrant).toHaveBeenLastCalledWith('member@example.com', true);
    expect(store.record).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'members', action: 'Scribd access granted', actor: 'admin@example.com' }));
    await setScribdAccess(req('/api/admin/members/scribd', { email: 'member@example.com', allowed: false }));
    expect(store.setGrant).toHaveBeenLastCalledWith('member@example.com', false);
    expect(store.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'Scribd access revoked' }));
  });

  it('serves bounded owner history without caching', async () => {
    const response = await getActivity(req('/api/admin/activity'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ ok: true, storage: 'cloudflare-d1', events: [{ id: '1' }] });
    expect(store.listActivity).toHaveBeenCalledWith(100);
  });
});
