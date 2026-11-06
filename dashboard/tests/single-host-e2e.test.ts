// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '../app/api/bot/sync/route';
import { enqueueBotCommand, getBotCommandById, getBotHeartbeat, isUsingCloudflareD1, saveBotConnectionConfig, saveMemberWhatsAppUser } from '../lib/storage';

const require = createRequire(import.meta.url);
const { createBotFixture } = require('../../the bot/scripts/test-sandbox.js') as { createBotFixture: (root: string) => string };
let memberTelemetry: { _resetForTests: (file: string | null) => void } | undefined;
let root = '';
afterEach(() => {
  memberTelemetry?._resetForTests(null); memberTelemetry = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); globalThis.__zafarD1SchemaV6Ready = undefined;
  globalThis.__zafarD1SchemaV6Promise = undefined; globalThis.__zafarD1UnreachableInDev = undefined;
  globalThis.__zafarBotReplayNonces?.clear();
});

it('connects the actual signed bot sync client to the single-service route using SQLite-backed D1', async () => {
  const db = new DatabaseSync(':memory:');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'botkeep-e2e-'));
  const botRoot = createBotFixture(root);
  const botRequire = createRequire(path.join(botRoot, 'scripts', 'test-sandbox.js'));
  memberTelemetry = botRequire('../gateway/users/usage.js');
  memberTelemetry!._resetForTests(path.join(root, 'member-usage.json'));
  const { startDashboardSync } = botRequire('../gateway/dashboard/sync.js') as { startDashboardSync: (options: Record<string, unknown>) => { syncNow: () => Promise<{ ok: boolean }>; stop: () => void } };
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test'); vi.stubEnv('D1_DATABASE_ID', 'test'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
    try { return Response.json({ success: true, result: [{ results: db.prepare(sql).all(...params) }] }); }
    catch (error) { return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 }); }
  }));
  try {
    expect(await isUsingCloudflareD1()).toBe(true);
    const token = 'private-test-sync-token';
    await saveBotConnectionConfig({ botSyncToken: token });
    expect(await saveMemberWhatsAppUser('15550001111', 'Pending member', 'member@example.com')).toBe(true);
    const command = await enqueueBotCommand({ type: 'pair', payload: { number: '15550001111' }, requestedBy: 'member@example.com' });
    let pairingCalls = 0;
    let policyVersion = '';
    const client = startDashboardSync({
      dashboardUrl: 'https://dashboard.example', token, manualOnly: true,
      wlFile: path.join(root, 'whitelist.json'),
      commandPolicy: { version: () => policyVersion, apply: (_disabled: unknown, version: string) => { policyVersion = version; } },
      getStatus: () => ({ connected: true, botNumber: '15550009999' }),
      requestPairing: async (number: string) => { pairingCalls++; expect(number).toBe('15550001111'); return { code: 'TEST-CODE', issuedAt: Date.now(), expiresInSeconds: 60 }; },
      fetchImpl: (url: string, init: RequestInit) => POST(new NextRequest(url, { ...init, signal: init.signal || undefined })),
    });
    try {
      expect(await client.syncNow()).toMatchObject({ ok: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(pairingCalls).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'whitelist.json'), 'utf8')).users[0]).toMatchObject({ number: '15550001111', enabled: false, pairAllowed: true });
      expect(await client.syncNow()).toMatchObject({ ok: true });
      expect(await getBotCommandById(command.id)).toMatchObject({ status: 'completed', result: { code: 'TEST-CODE' } });
      expect(await getBotHeartbeat()).toMatchObject({ connected: true, botNumber: '15550009999' });
    } finally { client.stop(); }
  } finally { db.close(); }
});
