// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovedUser, BotCommandRecord, BotHeartbeatRecord } from '../lib/types';

const state = vi.hoisted(() => ({
  heartbeat: null as BotHeartbeatRecord | null,
  config: { botApiUrl: '', botAdminToken: '', botSyncToken: 'test', botEnabledForMembers: true },
  users: new Map<string, ApprovedUser>(),
  commands: new Map<string, BotCommandRecord>(),
  sequence: 0,
}));
const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (params: { type: 'pair'; payload: Record<string, unknown>; requestedBy?: string; ttlMs: number }) => {
    const now = Date.now();
    const number = String(params.payload.number);
    const command: BotCommandRecord = {
      id: `request-${++state.sequence}`, type: params.type, payload: params.payload,
      status: 'completed', requestedBy: params.requestedBy, createdAt: now, expiresAt: now + params.ttlMs,
      result: { code: `CODE-${number.slice(-4)}`, issuedAt: now, expiresInSeconds: 60 },
    };
    state.commands.set(command.id, command);
    return command;
  }),
}));
vi.mock('../lib/storage', () => ({
  enqueueBotCommand: mocks.enqueue,
  getBotCommandById: vi.fn(async (id: string) => state.commands.get(id) || null),
  getBotConnectionConfig: vi.fn(async () => state.config),
  getBotHeartbeat: vi.fn(async () => state.heartbeat),
  getStoredWhatsAppUser: vi.fn(async (number: string) => state.users.get(number) || null),
  setFastPollWindow: vi.fn(async () => {}),
}));

import { checkQueuedPairCommand, fetchLiveBotStatus, requestLiveBotPairingCode } from '../lib/bot-proxy';
import { accountStatusLabel, readAccountStatuses, serviceText } from '../lib/whatsapp-accounts';

beforeEach(() => {
  state.heartbeat = null;
  state.config = { botApiUrl: '', botAdminToken: '', botSyncToken: 'test', botEnabledForMembers: true };
  state.users = new Map([
    ['15550001111', { number: '15550001111', label: 'One', enabled: true, addedBy: 'member@example.com' }],
    ['15550002222', { number: '15550002222', label: 'Two', enabled: true, addedBy: 'member@example.com' }],
  ]);
  state.commands = new Map();
  state.sequence = 0;
  mocks.enqueue.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('independent pairing bridge', () => {
  it('queues concurrent approved numbers even when an existing account is connected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    state.heartbeat = { lastSeenAt: Date.now(), connected: true, botNumber: '15550009999' };
    state.config.botApiUrl = 'https://direct.example';
    state.config.botAdminToken = 'secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const one = requestLiveBotPairingCode('15550001111', 'One', 'member@example.com', true);
    const two = requestLiveBotPairingCode('15550002222', 'Two', 'member@example.com', true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await one).toMatchObject({ ok: true, code: 'CODE-1111' });
    expect(await two).toMatchObject({ ok: true, code: 'CODE-2222' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets an administrator request an approved member number without transferring ownership', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    state.heartbeat = { lastSeenAt: Date.now(), connected: true, botNumber: '15550009999' };
    const result = requestLiveBotPairingCode('15550001111', 'One', 'admin@example.com');
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ ok: true, code: 'CODE-1111' });
    expect(state.users.get('15550001111')?.addedBy).toBe('member@example.com');
  });

  it('does not queue a pairing command for a withdrawn number', async () => {
    state.users.get('15550001111')!.enabled = false;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestLiveBotPairingCode('15550001111', 'One', 'member@example.com', true))
      .toMatchObject({ ok: false, status: 403 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the signed sync command even when the optional direct API is configured', async () => {
    state.config.botApiUrl = 'https://direct.example';
    state.config.botAdminToken = 'secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestLiveBotPairingCode('15550001111', 'One', 'member@example.com', true))
      .toMatchObject({ ok: true, code: 'CODE-1111' });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pair', payload: { number: '15550001111', label: 'One' },
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a clock-skewed issuance fallback fixed across later polls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    const now = Date.now();
    const cmd: BotCommandRecord = {
      id: 'skewed', type: 'pair', payload: { number: '15550001111' }, status: 'completed',
      requestedBy: 'member@example.com', createdAt: now - 5_000, expiresAt: now + 85_000,
      result: { code: 'TESTCODE', issuedAt: now + 10_000, _dashboardReceivedAt: now, expiresInSeconds: 60 },
    };
    state.commands.set(cmd.id, cmd);
    expect(await checkQueuedPairCommand(cmd.id, 'member@example.com')).toMatchObject({ ok: true, issuedAt: cmd.createdAt });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await checkQueuedPairCommand(cmd.id, 'member@example.com')).toMatchObject({ ok: true, issuedAt: cmd.createdAt });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await checkQueuedPairCommand(cmd.id, 'member@example.com')).toMatchObject({ ok: false, status: 410 });
  });

  it('uses a plausible issuance timestamp bounded by the fixed receipt time', async () => {
    const now = Date.now();
    const cmd: BotCommandRecord = {
      id: 'valid', type: 'pair', payload: { number: '15550001111' }, status: 'completed',
      requestedBy: 'member@example.com', createdAt: now - 10_000, expiresAt: now + 80_000,
      result: { code: 'TESTCODE', issuedAt: now - 2_000, _dashboardReceivedAt: now, expiresInSeconds: 60 },
    };
    state.commands.set(cmd.id, cmd);
    expect(await checkQueuedPairCommand(cmd.id, 'member@example.com')).toMatchObject({ ok: true, issuedAt: now - 2_000 });
  });

  it('checks both requester identity and current number ownership for queued results', async () => {
    const now = Date.now();
    const cmd: BotCommandRecord = { id: 'one', type: 'pair', payload: { number: '15550001111' }, status: 'completed', requestedBy: 'member@example.com', result: { code: 'TESTCODE', issuedAt: now, expiresInSeconds: 60 }, createdAt: now, expiresAt: now + 90_000 };
    state.commands.set(cmd.id, cmd);
    expect(await checkQueuedPairCommand('one', 'other@example.com')).toMatchObject({ ok: false, status: 404 });
    expect(await checkQueuedPairCommand('one', 'member@example.com')).toMatchObject({ ok: true, code: 'TESTCODE', issuedAt: now });
    state.users.get('15550001111')!.addedBy = 'other@example.com';
    expect(await checkQueuedPairCommand('one', 'member@example.com')).toMatchObject({ ok: false, status: 403 });
    expect(await checkQueuedPairCommand('one')).toMatchObject({ ok: true, code: 'TESTCODE' });
  });
});

describe('reported link status', () => {
  it('validates account state and never guesses when an older service reports no accounts', async () => {
    expect(readAccountStatuses([{ number: '15550001111', state: 'connected' }, { number: 'bad', state: 'connected' }, { number: '15550002222', state: 'invented' }])).toEqual([{ number: '15550001111', state: 'connected' }]);
    state.heartbeat = { lastSeenAt: Date.now(), connected: true, botNumber: '15550009999' };
    const old = await fetchLiveBotStatus();
    expect(old.accounts).toBeUndefined();
    expect(accountStatusLabel(old.accounts, '15550001111')).toBe('Link status unknown');
    expect(accountStatusLabel([{ number: '15550001111', state: 'awaiting_link' }], '15550001111')).toBe('Waiting for linking');
    expect(accountStatusLabel([{ number: '15550001111', state: 'connected' }], '15550001111')).toBe('Linked and connected');
    expect(serviceText('ZaFar Bot is waiting')).toBe('WhatsApp service is waiting');
  });

  it('does not reuse stale individual account states while the service is offline', async () => {
    state.heartbeat = { lastSeenAt: Date.now() - 120_000, connected: true, botNumber: '15550009999', accounts: [{ number: '15550001111', state: 'connected' }] };
    const status = await fetchLiveBotStatus();
    expect(status).toMatchObject({ reachable: false, connected: null, connectionMode: 'heartbeat' });
    expect(status.accounts).toBeUndefined();
  });
});
