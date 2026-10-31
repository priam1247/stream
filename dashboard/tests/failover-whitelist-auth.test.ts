// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ enabled: false, activateDuringSnapshot: false, role: 'legacy' as 'legacy' | 'xs' | 'botkeep' }));
vi.mock('../lib/bot-sync-auth', () => ({ verifyBotSyncRequest: async () => ({ ok: true, status: 200, credentialRole: state.role }) }));
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => 'test', recordRateLimitHit: () => {} }));
vi.mock('../lib/storage', () => ({ getFailoverStatus: async () => ({ enabled: state.enabled }),
  computeWhitelistSnapshot: async () => { if (state.activateDuringSnapshot) state.enabled = true;
    return { version: 'version', botEnabledForMembers: true, numbers: [], users: [] }; } }));
import { GET } from '../app/api/bot/whitelist/route';
const request = () => new NextRequest('https://dashboard.example/api/bot/whitelist');
beforeEach(() => { state.enabled = false; state.activateDuringSnapshot = false; state.role = 'legacy'; });

it('keeps legacy whitelist access for single-host mode but requires host credentials after failover starts', async () => {
  expect((await GET(request())).status).toBe(200);
  state.enabled = true;
  expect((await GET(request())).status).toBe(403);
  state.role = 'xs'; expect((await GET(request())).status).toBe(200);
  state.role = 'botkeep'; expect((await GET(request())).status).toBe(200);
});

it('does not return a legacy whitelist if failover activates while building the snapshot', async () => {
  state.activateDuringSnapshot = true;
  expect((await GET(request())).status).toBe(403);
});
