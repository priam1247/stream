// @vitest-environment node
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cfg: {
  botApiUrl: '', botAdminToken: 'legacy-admin-secret', botSyncToken: 'legacy-sync-secret',
  botXsSyncToken: 'xs-private-test-token-1234567890abcdef',
  botBotkeepSyncToken: 'backup-private-test-token-1234567890abcdef', botEnabledForMembers: true,
} }));
vi.mock('../lib/storage', () => ({ getBotConnectionConfig: async () => state.cfg }));
import { verifyBotSyncRequest } from '../lib/bot-sync-auth';

const body = JSON.stringify({ failover: { role: 'xs', instance: 'a'.repeat(32) } });
function request(token: string, signed = true, rawBody = body) {
  const timestamp = String(Date.now()); const nonce = crypto.randomBytes(16).toString('hex');
  const signature = 'sha256=' + crypto.createHmac('sha256', token).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  return new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body: rawBody,
    headers: { authorization: `Bearer ${token}`, ...(signed ? { 'x-bot-timestamp': timestamp, 'x-bot-nonce': nonce, 'x-bot-signature': signature } : {}) } });
}
beforeEach(() => {
  state.cfg = { botApiUrl: '', botAdminToken: 'legacy-admin-secret', botSyncToken: 'legacy-sync-secret',
    botXsSyncToken: 'xs-private-test-token-1234567890abcdef', botBotkeepSyncToken: 'backup-private-test-token-1234567890abcdef', botEnabledForMembers: true };
  vi.stubEnv('BOT_SYNC_TOKEN', ''); vi.stubEnv('ADMIN_DASHBOARD_TOKEN', '');
  globalThis.__zafarBotReplayNonces?.clear();
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.__zafarBotReplayNonces?.clear(); });

describe('role-bound WhatsApp sync credentials', () => {
  it('preserves legacy bearer-only auth but identifies each signed failover role', async () => {
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken, false), body)).toMatchObject({ ok: true, credentialRole: 'legacy' });
    expect(await verifyBotSyncRequest(request(state.cfg.botXsSyncToken), body)).toMatchObject({ ok: true, credentialRole: 'xs' });
    expect(await verifyBotSyncRequest(request(state.cfg.botBotkeepSyncToken), body)).toMatchObject({ ok: true, credentialRole: 'botkeep' });
  });
  it('requires signatures for role-bound credentials and rejects a wrong HMAC', async () => {
    expect(await verifyBotSyncRequest(request(state.cfg.botXsSyncToken, false), body)).toMatchObject({ ok: false, status: 401 });
    expect(await verifyBotSyncRequest(request(state.cfg.botBotkeepSyncToken), body + 'changed')).toMatchObject({ ok: false, status: 401 });
  });
  it('does not consume the nonce for an invalid signature before the genuine request arrives', async () => {
    const good = request(state.cfg.botXsSyncToken);
    const headers = new Headers(good.headers); headers.set('x-bot-signature', `sha256=${'0'.repeat(64)}`);
    const bad = new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', headers, body });
    expect(await verifyBotSyncRequest(bad, body)).toMatchObject({ ok: false, status: 401 });
    expect(await verifyBotSyncRequest(good, body)).toMatchObject({ ok: true, credentialRole: 'xs' });
    expect(await verifyBotSyncRequest(good, body)).toMatchObject({ ok: false, status: 409 });
  });
  it('rejects weak host credentials even when supplied through environment settings', async () => {
    state.cfg.botXsSyncToken = 'short';
    expect(await verifyBotSyncRequest(request('short'), body)).toMatchObject({ ok: false, status: 503 });
  });
  it('fails closed when a role credential is reused for another role or the legacy token', async () => {
    state.cfg.botXsSyncToken = state.cfg.botBotkeepSyncToken;
    expect(await verifyBotSyncRequest(request(state.cfg.botXsSyncToken), body)).toMatchObject({ ok: false, status: 503 });
    state.cfg.botXsSyncToken = state.cfg.botSyncToken;
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken), body)).toMatchObject({ ok: false, status: 503 });
    state.cfg.botXsSyncToken = 'xs-private-test-token-1234567890abcdef';
    vi.stubEnv('BOT_SYNC_TOKEN', state.cfg.botXsSyncToken);
    expect(await verifyBotSyncRequest(request(state.cfg.botXsSyncToken), body)).toMatchObject({ ok: false, status: 503 });
  });
});
