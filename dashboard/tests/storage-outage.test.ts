// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('node:fs', () => ({ default: {
  existsSync: () => disk.text !== null, readFileSync: () => disk.text,
  mkdirSync: () => {}, writeFileSync: (_path: string, value: string) => { disk.text = value; },
} }));
import { claimPendingBotCommands, completeBotCommand, enqueueBotCommand, getBotCommandById, getBotHeartbeat,
  getEligibleSessionBackup, getSessionBackup, listSessionBackupMetadata, putSessionBackup,
  revokeSessionBackup, saveBotHeartbeat } from '../lib/storage';
beforeEach(() => {
  disk.text = null;
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account'); vi.stubEnv('D1_DATABASE_ID', 'database'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '');
  globalThis.__zafarD1UnreachableInDev = false; globalThis.__zafarD1SchemaV6Ready = true;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('D1 unreachable'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); globalThis.__zafarD1UnreachableInDev = undefined; globalThis.__zafarD1SchemaV6Ready = undefined; globalThis.__zafarD1SchemaV6Promise = undefined; });
it('fails closed on configured database outages by default and in production', async () => {
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null })).rejects.toThrow(/unreachable/);
  await expect(claimPendingBotCommands()).rejects.toThrow(/unreachable/);
  expect(disk.text).toBeNull();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  await expect(saveBotHeartbeat({ lastSeenAt: 1, connected: true, botNumber: null })).rejects.toThrow(/unreachable/);
  expect(disk.text).toBeNull();
});
it('allows disk fallback only when isolated development explicitly opts in', async () => {
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  await saveBotHeartbeat({ lastSeenAt: 123, connected: true, botNumber: null });
  expect(await getBotHeartbeat()).toMatchObject({ lastSeenAt: 123 });
  const command = await enqueueBotCommand({ type: 'pair', payload: { number: '15550001111' } });
  expect((await claimPendingBotCommands()).map((item) => item.id)).toContain(command.id);
  await completeBotCommand({ id: command.id, ok: true });
  expect(await getBotCommandById(command.id)).toMatchObject({ status: 'completed' });
});
it('never treats an unavailable recovery database as an empty backup', async () => {
  vi.stubEnv('ZAFAR_DEV_STANDALONE_FALLBACK', '1');
  await expect(listSessionBackupMetadata()).rejects.toThrow(/unavailable/);
  await expect(getSessionBackup('primary')).rejects.toThrow(/unavailable/);
  await expect(getEligibleSessionBackup('primary', 'primary')).rejects.toThrow(/unavailable/);
  await expect(putSessionBackup('primary', 'a'.repeat(24), 'primary', 'ciphertext', 0)).rejects.toThrow(/unavailable/);
  await expect(revokeSessionBackup('primary', 'a'.repeat(24))).rejects.toThrow(/unavailable/);
});
