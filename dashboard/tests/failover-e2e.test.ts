// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '../app/api/bot/sync/route';
import { getBotHeartbeat, getFailoverStatus } from '../lib/storage';

const require = createRequire(import.meta.url);
const { createFailoverLease } = require('../../Whatsapp bot/utils/failoverLease.js');
const { startDashboardSync, buildSignedHeaders } = require('../../Whatsapp bot/utils/dashboardSync.js');
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  globalThis.__zafarD1SchemaV6Ready = undefined;
  globalThis.__zafarD1SchemaV6Promise = undefined;
  globalThis.__zafarD1UnreachableInDev = undefined;
  globalThis.__zafarFailoverSchemaReady = undefined;
  globalThis.__zafarFailoverSchemaPromise = undefined;
  globalThis.__zafarBotReplayNonces?.clear();
});

it('exercises signed XS and Botkeep bridge handover against atomic SQLite, without live hosts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-failover-e2e-'));
  const db = new DatabaseSync(':memory:');
  const controllers: { stop: () => void }[] = [];
  try {
    db.exec(`
      CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE portal_bot_commands (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, result_json TEXT, error_text TEXT, requested_by TEXT, created_at INTEGER, expires_at INTEGER);
      CREATE TABLE portal_whatsapp_access (number TEXT PRIMARY KEY, label TEXT, enabled INTEGER, added_by TEXT,
        added_at TEXT, approval_status TEXT, claim_id TEXT);
      CREATE TABLE portal_member_permissions (email TEXT PRIMARY KEY, name TEXT, allowed INTEGER, updated_at TEXT);
      INSERT INTO portal_settings VALUES ('bot_sync_token', 'offline-legacy-test-secret', '2026-01-01');
      INSERT INTO portal_settings VALUES ('bot_xs_sync_token', 'offline-xs-test-secret-12345678901234567890', '2026-01-01');
      INSERT INTO portal_settings VALUES ('bot_botkeep_sync_token', 'offline-backup-test-secret-12345678901234567890', '2026-01-01');
      INSERT INTO portal_whatsapp_access VALUES ('15550001111', 'Member', 1, 'owner@example.com', '2026-01-01', 'approved', 'claim-1');
    `);
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test'); vi.stubEnv('D1_DATABASE_ID', 'test'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
    globalThis.__zafarD1SchemaV6Ready = true;
    globalThis.__zafarFailoverSchemaReady = undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
      try { return Response.json({ success: true, result: [{ results: db.prepare(sql).all(...params) }] }); }
      catch (error) { return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 }); }
    }));
    const routeFetch = async (url: string, init: RequestInit) => POST(new NextRequest(url, { ...init, signal: init.signal ?? undefined }));
    const pairs = { xs: 0, botkeep: 0 };
    let xsPrimaryConnected = true;
    const xsLease = createFailoverLease('xs', { instance: 'a'.repeat(32) });
    const backupLease = createFailoverLease('botkeep', { instance: 'b'.repeat(32) });
    const makeSync = (role: 'xs' | 'botkeep', lease: unknown) => {
      const sync = startDashboardSync({ dashboardUrl: 'https://dashboard.example',
        token: role === 'xs' ? 'offline-xs-test-secret-12345678901234567890' : 'offline-backup-test-secret-12345678901234567890',
        manualOnly: true, wlFile: join(root, `${role}.json`), failover: lease, fetchImpl: routeFetch,
        getStatus: () => ({ connected: true, primaryConnected: role === 'xs' ? xsPrimaryConnected : true,
          botNumber: role === 'xs' && !xsPrimaryConnected ? '15550001111' : '15550009999', primaryNumber: '15550009999',
          primaryDeviceFingerprint: (role === 'xs' ? '1' : '2').repeat(64) }),
        requestPairing: async () => { pairs[role]++; return { code: `CODE-${role}`, issuedAt: Date.now() }; },
      });
      controllers.push(sync); return sync;
    };
    const xs = makeSync('xs', xsLease);
    const backup = makeSync('botkeep', backupLease);

    const identityBody = JSON.stringify({ connected: true, botNumber: '15550009999', failover: {
      role: 'xs', instance: 'c'.repeat(32), epoch: 0, primaryConnected: true,
      accountNumber: '15550009999', deviceFingerprint: '3'.repeat(64),
    } });
    for (const token of ['offline-legacy-test-secret', 'offline-backup-test-secret-12345678901234567890']) {
      const spoof = new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body: identityBody,
        headers: buildSignedHeaders(token, 'POST', '/api/bot/sync', identityBody) });
      expect((await POST(spoof)).status).toBe(403);
    }
    const noIdentity = JSON.stringify({ connected: false });
    const roleAsLegacy = new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body: noIdentity,
      headers: buildSignedHeaders('offline-xs-test-secret-12345678901234567890', 'POST', '/api/bot/sync', noIdentity) });
    expect((await POST(roleAsLegacy)).status).toBe(403);
    const legacy = new NextRequest('https://dashboard.example/api/bot/sync', { method: 'POST', body: noIdentity,
      headers: { authorization: 'Bearer offline-legacy-test-secret' } });
    expect((await POST(legacy)).status).toBe(200);

    expect((await xs.syncNow()).ok).toBe(true);
    expect((await backup.syncNow()).ok).toBe(true);
    expect(xsLease.canServe()).toBe(true);
    expect(backupLease.canServe()).toBe(false);
    expect(await getFailoverStatus()).toMatchObject({ enabled: true, activeRole: 'xs', epoch: 1 });
    expect(await getBotHeartbeat()).toMatchObject({ failover: { role: 'xs', epoch: 1 } });

    const insertCommand = db.prepare(`INSERT INTO portal_bot_commands VALUES (?, 'pair', ?, 'pending', NULL, NULL, 'owner@example.com', ?, ?)`);
    insertCommand.run('pair-1', JSON.stringify({ number: '15550001111' }), Date.now(), Date.now() + 60_000);
    await Promise.all([backup.syncNow(), xs.syncNow()]); await flush();
    expect(pairs).toEqual({ xs: 1, botkeep: 0 });
    await xs.syncNow();
    expect(db.prepare("SELECT status FROM portal_bot_commands WHERE id = 'pair-1'").get()).toMatchObject({ status: 'completed' });

    // XS loses its primary WhatsApp device while an unrelated member remains
    // online. The aggregate botNumber changes, but the failover identity must not.
    xsPrimaryConnected = false;
    await xs.syncNow();
    expect(xsLease.canServe()).toBe(false);
    db.exec('UPDATE portal_bot_failover SET expires_at = 0');
    await backup.syncNow();
    expect(backupLease.canServe()).toBe(true);
    expect(await getFailoverStatus()).toMatchObject({ activeRole: 'botkeep', epoch: 2, issue: null });
    insertCommand.run('pair-2', JSON.stringify({ number: '15550001111' }), Date.now(), Date.now() + 60_000);
    await backup.syncNow(); await flush();
    expect(pairs).toEqual({ xs: 1, botkeep: 1 });

    // XS announces its return. Neither side may preempt the still-live lease.
    xsPrimaryConnected = true;
    await xs.syncNow();
    expect(xsLease.canServe()).toBe(false);
    await backup.syncNow();
    expect(backupLease.canServe()).toBe(false);
    db.exec('UPDATE portal_bot_failover SET expires_at = 0');
    await xs.syncNow();
    expect(xsLease.canServe()).toBe(true);
    expect(await getFailoverStatus()).toMatchObject({ activeRole: 'xs', epoch: 3 });
    expect(await getBotHeartbeat()).toMatchObject({ failover: { role: 'xs', epoch: 3 } });
  } finally {
    for (const controller of controllers) controller.stop();
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
