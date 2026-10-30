// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { claimPairCooldown, completeBotCommand, isUsingCloudflareD1, saveMemberWhatsAppUser } from '../lib/storage';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  globalThis.__zafarD1SchemaV5Ready = undefined;
  globalThis.__zafarD1SchemaV5Promise = undefined;
  globalThis.__zafarD1UnreachableInDev = undefined;
});

it('initializes D1 tables once when concurrent requests arrive on a cold start', async () => {
  globalThis.__zafarD1SchemaV5Ready = undefined;
  globalThis.__zafarD1SchemaV5Promise = undefined;
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
  expect(sql.filter((query) => query.includes('CREATE TABLE IF NOT EXISTS portal_pair_cooldowns'))).toHaveLength(1);
});

it('guards D1 command completion against duplicate result reports', async () => {
  globalThis.__zafarD1SchemaV5Ready = true;
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

it('uses an atomic conditional D1 upsert for the resend cooldown', async () => {
  globalThis.__zafarD1SchemaV5Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('D1_DATABASE_ID', 'test-db');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const queries: { sql: string; params: unknown[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)));
    return Response.json({ success: true, result: [{ results: [{ retry_at: 181_000 }] }] });
  }));
  expect(await claimPairCooldown('265991234567', 1000)).toEqual({ ok: true, retryAt: 181_000 });
  const sql = queries[0].sql;
  expect(sql).toMatch(/ON CONFLICT\(number\) DO UPDATE/i);
  expect(sql).toMatch(/WHERE portal_pair_cooldowns.retry_at <= \? RETURNING/i);
  expect(queries[0].params).toEqual(['265991234567', 181_000, 1000]);
});

it('atomically claims a member number only for its existing owner', async () => {
  globalThis.__zafarD1SchemaV5Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('D1_DATABASE_ID', 'test-db');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const queries: { sql: string; params: unknown[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)));
    return Response.json({ success: true, result: [{ results: [] }] });
  }));
  expect(await saveMemberWhatsAppUser('265991234567', 'Member', 'MEMBER@example.com')).toBe(false);
  expect(queries[0].sql).toMatch(/ON CONFLICT\(number\) DO UPDATE/i);
  expect(queries[0].sql).toMatch(/lower\(portal_whatsapp_access.added_by\) = \?/i);
  expect(queries[0].params[4]).toBe('member@example.com');
});
