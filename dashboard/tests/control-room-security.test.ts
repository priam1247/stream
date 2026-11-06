import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' | 'anonymous' }));
const store = vi.hoisted(() => ({
  listActivity: vi.fn(async () => [{ id: '1', category: 'members', action: 'Member allowed' }]),
}));
vi.mock('../lib/auth-engine', () => ({
  getAuthenticatedSession: vi.fn(async () => state.role === 'anonymous' ? null : { user: { isAdmin: state.role === 'admin', email: `${state.role}@example.com` } }),
  isAdminEmail: (email: string) => email === 'admin@example.com',
}));
vi.mock('../lib/storage', () => ({
  listRecentActivity: store.listActivity,
  isUsingCloudflareD1: vi.fn(async () => true),
}));
import { GET as getActivity } from '../app/api/admin/activity/route';

function req(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

beforeEach(() => {
  state.role = 'admin';
  vi.clearAllMocks();
});

describe('owner controls', () => {
  it('limits activity history changes to signed-in administrators', async () => {
    for (const role of ['anonymous', 'member'] as const) {
      state.role = role;
      const expected = role === 'anonymous' ? 401 : 403;
      expect((await getActivity(req('/api/admin/activity'))).status).toBe(expected);
    }
    expect(store.listActivity).not.toHaveBeenCalled();
  });

  it('serves bounded owner history without caching', async () => {
    const response = await getActivity(req('/api/admin/activity'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ ok: true, storage: 'cloudflare-d1', events: [{ id: '1' }] });
    expect(store.listActivity).toHaveBeenCalledWith(100);
  });
});
