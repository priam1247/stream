// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  claimPendingBotCommands, completeBotCommand, enqueueBotCommand, getBotCommandById, getBotHeartbeat,
  getEligibleSessionBackup, getSessionBackup, listSessionBackupMetadata, putSessionBackup,
  revokeSessionBackup, saveBotHeartbeat, saveBotConnectionConfig,
} from '../lib/storage';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('D1 unreachable'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); globalThis.__zafarD1SchemaV6Ready = undefined; globalThis.__zafarD1SchemaV6Promise = undefined; });

it('refuses every write and read when D1 is not configured, instead of using local disk', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
  vi.stubEnv('D1_DATABASE_ID', '');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null })).rejects.toThrow(/Cloudflare D1 is required/);
  await expect(getBotHeartbeat()).rejects.toThrow(/Cloudflare D1 is required/);
  await expect(claimPendingBotCommands()).rejects.toThrow(/Cloudflare D1 is required/);
  await expect(saveBotConnectionConfig({ botSyncToken: 'x' })).rejects.toThrow(/Cloudflare D1 is required/);
});

it('the old isolated-development disk flag cannot rescue a missing database', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
  vi.stubEnv('D1_DATABASE_ID', '');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
  vi.stubEnv('NODE_ENV', 'development');
  await expect(saveBotHeartbeat({ lastSeenAt: 123, connected: true, botNumber: null }))
    .rejects.toThrow(/Cloudflare D1 is required/);
  await expect(enqueueBotCommand({ type: 'pair', payload: { number: '15550001111' } }))
    .rejects.toThrow(/Cloudflare D1 is required/);
});

it('fails closed on a configured database outage by default and in production', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account');
  vi.stubEnv('D1_DATABASE_ID', 'database');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
  vi.stubEnv('NODE_ENV', 'development');
  globalThis.__zafarD1SchemaV6Ready = true;
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null })).rejects.toThrow(/unreachable/);
  await expect(claimPendingBotCommands()).rejects.toThrow(/unreachable/);
  vi.stubEnv('NODE_ENV', 'production');
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null })).rejects.toThrow(/unreachable/);
});

it('never treats an unavailable recovery database as an empty backup', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account');
  vi.stubEnv('D1_DATABASE_ID', 'database');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
  globalThis.__zafarD1SchemaV6Ready = true;
  await expect(listSessionBackupMetadata()).rejects.toThrow(/unreachable/);
  await expect(getSessionBackup('primary')).rejects.toThrow(/unreachable/);
  await expect(getEligibleSessionBackup('primary', 'primary')).rejects.toThrow(/unreachable/);
  await expect(putSessionBackup('primary', 'a'.repeat(24), 'primary', 'ciphertext', 0)).rejects.toThrow(/unreachable/);
  await expect(revokeSessionBackup('primary', 'a'.repeat(24))).rejects.toThrow(/unreachable/);
});
