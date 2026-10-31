// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('node:fs', () => ({ default: {
  existsSync: () => disk.text !== null,
  readFileSync: () => disk.text,
  mkdirSync: () => {},
  writeFileSync: (_path: string, value: string) => { disk.text = value; },
} }));
import { claimFailoverLease, claimPendingBotCommands, completeBotCommand, enqueueBotCommand, getBotCommandById,
  getBotHeartbeat, getFailoverStatus, importLocalUserForLease, listSessionBackupMetadata, getSessionBackup,
  getEligibleSessionBackup, putSessionBackup, revokeSessionBackup, saveBotHeartbeat } from '../lib/storage';

const identity = { role: 'xs' as const, instance: 'a'.repeat(32), epoch: 1 };
beforeEach(() => {
  disk.text = null;
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account'); vi.stubEnv('D1_DATABASE_ID', 'database'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '');
  globalThis.__zafarD1UnreachableInDev = true;
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  globalThis.__zafarD1UnreachableInDev = undefined;
  globalThis.__zafarD1SchemaV6Ready = undefined;
  globalThis.__zafarFailoverSchemaReady = undefined;
});

it('fails closed by default and never permits a fenced mutation on a disk store', async () => {
  await expect(getFailoverStatus()).rejects.toThrow(/unavailable/);
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null })).rejects.toThrow(/unavailable/);
  await expect(claimPendingBotCommands()).rejects.toThrow(/D1/);
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  await expect(claimFailoverLease(identity, { connected: true, accountNumber: '15550009999', deviceFingerprint: '1'.repeat(64) })).rejects.toThrow(/D1/);
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null }, identity)).rejects.toThrow(/unavailable/);
  await expect(claimPendingBotCommands(identity)).rejects.toThrow(/D1/);
  await expect(completeBotCommand({ id: 'one', ok: true }, identity)).rejects.toThrow(/D1/);
  await expect(importLocalUserForLease('15550001111', 'Member', 'owner@example.com', identity)).rejects.toThrow(/unavailable/);
  vi.stubEnv('NODE_ENV', 'production');
  await expect(getFailoverStatus()).rejects.toThrow(/unavailable/);
});

it('allows explicitly opted-in local standalone development to use disk', async () => {
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  expect(await getFailoverStatus()).toMatchObject({ enabled: false });
  await saveBotHeartbeat({ lastSeenAt: 123, connected: true, botNumber: null });
  expect(await getBotHeartbeat()).toMatchObject({ lastSeenAt: 123 });
  const command = await enqueueBotCommand({ type: 'restart', payload: {} });
  expect((await claimPendingBotCommands()).map((item) => item.id)).toContain(command.id);
  await completeBotCommand({ id: command.id, ok: true });
  expect(await getBotCommandById(command.id)).toMatchObject({ status: 'completed' });
  expect(await importLocalUserForLease('15550001111', 'Member', 'owner@example.com')).toBe(true);
});

it('falls back on the first failed D1 query only when isolated development explicitly opts in', async () => {
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  globalThis.__zafarD1UnreachableInDev = false;
  globalThis.__zafarD1SchemaV6Ready = true;
  globalThis.__zafarFailoverSchemaReady = true;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
  expect(await getFailoverStatus()).toMatchObject({ enabled: false });
  expect(globalThis.__zafarD1UnreachableInDev).toBe(true);
  await saveBotHeartbeat({ lastSeenAt: 456, connected: true, botNumber: null });
  expect(await getBotHeartbeat()).toMatchObject({ lastSeenAt: 456 });
});

it('never treats an unavailable recovery database as an empty or missing backup', async () => {
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  await expect(listSessionBackupMetadata()).rejects.toThrow(/unavailable/);
  await expect(getSessionBackup('primary')).rejects.toThrow(/unavailable/);
  await expect(getEligibleSessionBackup('primary', 'primary')).rejects.toThrow(/unavailable/);
  await expect(putSessionBackup('primary', 'a'.repeat(24), 'primary', 'ciphertext', 0)).rejects.toThrow(/unavailable/);
  await expect(revokeSessionBackup('primary', 'a'.repeat(24))).rejects.toThrow(/unavailable/);
  // Also reject the first failing D1 query after schema initialization.
  globalThis.__zafarD1UnreachableInDev = false;
  globalThis.__zafarD1SchemaV6Ready = true;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
  await expect(listSessionBackupMetadata()).rejects.toThrow(/unavailable/);
});
