// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { completeBotCommand, isUsingCloudflareD1 } from '../lib/storage';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  globalThis.__zafarD1SchemaV4Ready = undefined;
  globalThis.__zafarD1SchemaV4Promise = undefined;
  globalThis.__zafarD1UnreachableInDev = undefined;
});

it('initializes D1 tables once when concurrent requests arrive on a cold start', async () => {
  globalThis.__zafarD1SchemaV4Ready = undefined;
  globalThis.__zafarD1SchemaV4Promise = undefined;
  globalThis.__zafarD1UnreachableInDev = undefined;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('D1_DATABASE_ID', 'test-db');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const sql: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sql.push(JSON.parse(String(init.body)).sql);
    return Response.json({ success: true, result: [{ results: [] }] });
  }));
  expect(await Promise.all(Array.from({ length: 5 }, () => isUsingCloudflareD1()))).toEqual([true, true, true, true, true]);
  expect(sql.filter((query) => query.includes('CREATE TABLE IF NOT EXISTS portal_accounts'))).toHaveLength(1);
  expect(sql.filter((query) => query.includes('CREATE TABLE IF NOT EXISTS portal_member_features'))).toHaveLength(1);
  expect(sql.filter((query) => query.includes('CREATE TABLE IF NOT EXISTS portal_activity'))).toHaveLength(1);
});

it('guards D1 command completion against duplicate result reports', async () => {
  globalThis.__zafarD1SchemaV4Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('D1_DATABASE_ID', 'test-db');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const queries: { sql: string; params: unknown[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)));
    return Response.json({ success: true, result: [{ results: [] }] });
  }));
  const before = Date.now();
  await completeBotCommand({ id: 'one', ok: true, result: { code: 'FIRST', _dashboardReceivedAt: 1 } });
  const update = queries.find((q) => q.sql.includes('UPDATE portal_bot_commands'));
  expect(update?.sql).toMatch(/status IN \('pending', 'claimed'\)/);
  const result = JSON.parse(String(update?.params[1]));
  expect(result.code).toBe('FIRST');
  expect(result._dashboardReceivedAt).toBeGreaterThanOrEqual(before);
});
