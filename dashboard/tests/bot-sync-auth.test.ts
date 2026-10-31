// @vitest-environment node
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cfg: { botApiUrl: '', botAdminToken: 'bridge-secret-123', botSyncToken: 'botkeep-sync-secret-123', botEnabledForMembers: true } }));
vi.mock('../lib/storage', () => ({ getBotConnectionConfig: async () => state.cfg }));
import { verifyBotSyncRequest } from '../lib/bot-sync-auth';
const body = JSON.stringify({ connected: true });
function request(token: string, opts: { signed?: boolean; timestamp?: number; nonce?: string; signature?: string } = {}) {
  const ts = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce || crypto.randomBytes(16).toString('hex');
  const sig = opts.signature || 'sha256=' + crypto.createHmac('sha256', token).update(`${ts}.${nonce}.${body}`).digest('hex');
  return new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body,
    headers: { authorization: `Bearer ${token}`, ...(opts.signed === false ? {} : { 'x-bot-timestamp': ts, 'x-bot-nonce': nonce, 'x-bot-signature': sig }) } });
}
beforeEach(() => { state.cfg = { botApiUrl: '', botAdminToken: 'bridge-secret-123', botSyncToken: 'botkeep-sync-secret-123', botEnabledForMembers: true }; globalThis.__zafarBotReplayNonces?.clear(); });
afterEach(() => { vi.unstubAllEnvs(); globalThis.__zafarBotReplayNonces?.clear(); });

describe('single-service sync authentication', () => {
  it('keeps supported legacy bearer requests and validates signed requests', async () => {
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken, { signed: false }), body)).toMatchObject({ ok: true });
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken), body)).toMatchObject({ ok: true });
    expect(await verifyBotSyncRequest(request(state.cfg.botAdminToken), body)).toMatchObject({ ok: true });
    expect(await verifyBotSyncRequest(request('wrong'), body)).toMatchObject({ ok: false, status: 401 });
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken), body + 'changed')).toMatchObject({ ok: false, status: 401 });
  });
  it('does not consume a nonce until the HMAC succeeds; replay and stale timestamps fail', async () => {
    const nonce = 'nonce-123456789';
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken, { nonce, signature: `sha256=${'0'.repeat(64)}` }), body)).toMatchObject({ ok: false, status: 401 });
    const good = request(state.cfg.botSyncToken, { nonce });
    expect(await verifyBotSyncRequest(good, body)).toMatchObject({ ok: true });
    expect(await verifyBotSyncRequest(good, body)).toMatchObject({ ok: false, status: 409 });
    expect(await verifyBotSyncRequest(request(state.cfg.botSyncToken, { timestamp: Date.now() - 301_000 }), body)).toMatchObject({ ok: false, status: 401 });
  });
  it('does not authenticate a superseded environment secret independently of resolved settings', async () => {
    vi.stubEnv('BOT_SYNC_TOKEN', 'superseded-secret');
    expect(await verifyBotSyncRequest(request('superseded-secret', { signed: false }), body)).toMatchObject({ ok: false, status: 401 });
    state.cfg.botSyncToken = ''; state.cfg.botAdminToken = '';
    expect(await verifyBotSyncRequest(request('superseded-secret', { signed: false }), body)).toMatchObject({ ok: false, status: 503 });
  });
});
