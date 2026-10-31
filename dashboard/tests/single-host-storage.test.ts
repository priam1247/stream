// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOTKEEP_API_BASE } from '../lib/botkeep-config';
import { claimPendingBotCommands, completeBotCommand, getBotConnectionConfig, getBotHeartbeat, getPanelConnectionConfig,
  importLocalWhatsAppUser, saveBotConnectionConfig, saveBotHeartbeat, savePanelConnectionConfig } from '../lib/storage';

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE portal_bot_commands (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error_text TEXT, requested_by TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE portal_whatsapp_access (number TEXT PRIMARY KEY, label TEXT, enabled INTEGER, added_by TEXT,
      added_at TEXT, approval_status TEXT, claim_id TEXT);
    CREATE TABLE portal_bot_failover (id TEXT PRIMARY KEY, owner_role TEXT, owner_instance TEXT, expires_at INTEGER, epoch INTEGER);`);
  globalThis.__zafarD1SchemaV6Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test'); vi.stubEnv('D1_DATABASE_ID', 'test'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  for (const key of ['BOT_SYNC_TOKEN', 'ADMIN_DASHBOARD_TOKEN', 'BOT_BOTKEEP_SYNC_TOKEN', 'BOTKEEP_BOT_API_URL', 'BOTKEEP_BOT_ADMIN_TOKEN', 'BOTKEEP_WORKLOAD_ID', 'BOTKEEP_API_KEY']) vi.stubEnv(key, '');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
    try { return Response.json({ success: true, result: [{ results: db.prepare(sql).all(...params) }] }); }
    catch (error) { return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 }); }
  }));
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); globalThis.__zafarD1SchemaV6Ready = undefined; globalThis.__zafarD1SchemaV6Promise = undefined; globalThis.__zafarD1UnreachableInDev = undefined; });
function setting(key: string, value: string) { db.prepare('INSERT OR REPLACE INTO portal_settings VALUES (?, ?, ?)').run(key, value, '2026-01-01'); }

describe('single Botkeep storage with old database values', () => {
  it('ignores all old hosting and direct bridge credentials while retaining the shared sync token', async () => {
    for (const [key, val] of Object.entries({
      panel_url: 'https://old-host.invalid', panel_server_id: 'old-server', panel_api_key: 'old-key',
      xs_panel_url: 'https://old-host.invalid', xs_panel_server_id: 'old-server', xs_panel_api_key: 'old-key',
      bot_api_url: 'https://old-host.invalid', bot_admin_token: 'legacy-sync-secret', bot_sync_token: 'current-sync-secret',
    })) setting(key, val);
    vi.stubEnv('PANEL_URL', 'https://old-host.invalid'); vi.stubEnv('PANEL_API_KEY', 'old-key'); vi.stubEnv('PANEL_SERVER_ID', 'old-server');
    vi.stubEnv('BOT_API_URL', 'https://old-host.invalid'); vi.stubEnv('ADMIN_DASHBOARD_TOKEN', 'legacy-environment-secret');
    expect(await getPanelConnectionConfig()).toMatchObject({ panelUrl: BOTKEEP_API_BASE, panelServerId: '', panelApiKey: '' });
    expect(await getBotConnectionConfig()).toMatchObject({ botApiUrl: '', botAdminToken: '', botSyncToken: 'current-sync-secret' });
    await savePanelConnectionConfig({ panelServerId: 'workload-1', panelApiKey: 'botkeep-key-123456789' });
    expect(await getPanelConnectionConfig()).toMatchObject({ panelUrl: BOTKEEP_API_BASE, panelServerId: 'workload-1', panelApiKey: 'botkeep-key-123456789' });
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'panel_api_key'").get()).toMatchObject({ value: 'old-key' });
  });
  it('does not misreport the previous host heartbeat as Botkeep', async () => {
    setting('bot_heartbeat_json', JSON.stringify({ lastSeenAt: Date.now(), connected: true, botNumber: '15550009999' }));
    expect(await getBotHeartbeat()).toBeNull();
    await saveBotHeartbeat({ lastSeenAt: Date.now(), connected: false, botNumber: null });
    expect(await getBotHeartbeat()).toMatchObject({ connected: false });
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'bot_heartbeat_json'").get()).toBeTruthy();
  });
  it('honors only explicitly configured Botkeep bridge values, including clearing environment defaults', async () => {
    vi.stubEnv('BOTKEEP_BOT_API_URL', 'https://botkeep-service.example'); vi.stubEnv('BOTKEEP_BOT_ADMIN_TOKEN', 'new-bridge-token');
    expect(await getBotConnectionConfig()).toMatchObject({ botApiUrl: 'https://botkeep-service.example', botAdminToken: 'new-bridge-token' });
    await saveBotConnectionConfig({ botApiUrl: '', botAdminToken: '' });
    expect(await getBotConnectionConfig()).toMatchObject({ botApiUrl: '', botAdminToken: '' });
  });
  it('preserves existing single-host credentials and falls back to saved or environment Botkeep sync tokens', async () => {
    setting('bot_botkeep_sync_token', 'botkeep-saved-sync');
    expect((await getBotConnectionConfig()).botSyncToken).toBe('botkeep-saved-sync');
    setting('bot_admin_token', 'legacy-admin-sync');
    expect((await getBotConnectionConfig()).botSyncToken).toBe('legacy-admin-sync');
    setting('bot_sync_token', 'explicit-single-host');
    expect((await getBotConnectionConfig()).botSyncToken).toBe('explicit-single-host');
    db.prepare('DELETE FROM portal_settings').run(); vi.stubEnv('BOT_BOTKEEP_SYNC_TOKEN', 'botkeep-env-sync');
    expect((await getBotConnectionConfig()).botSyncToken).toBe('botkeep-env-sync');
  });
  it('preserves independent settings on simultaneous updates', async () => {
    await Promise.all([
      saveBotConnectionConfig({ botSyncToken: 'new-sync-token' }),
      saveBotConnectionConfig({ botApiUrl: 'https://new-bot.example', botAdminToken: 'new-bridge-token' }),
      saveBotConnectionConfig({ botEnabledForMembers: false }),
      savePanelConnectionConfig({ panelServerId: 'workload-new' }),
      savePanelConnectionConfig({ panelApiKey: 'botkeep-api-key-123456' }),
    ]);
    expect(await getBotConnectionConfig()).toMatchObject({ botSyncToken: 'new-sync-token', botApiUrl: 'https://new-bot.example', botAdminToken: 'new-bridge-token', botEnabledForMembers: false });
    expect(await getPanelConnectionConfig()).toMatchObject({ panelServerId: 'workload-new', panelApiKey: 'botkeep-api-key-123456' });
  });
  it('does not let a local owner import overwrite or re-enable a member', async () => {
    db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, 'Member', 0, 'member@example.com', '2026-01-01', 'pending', 'claim')`).run('15550001111');
    expect(await importLocalWhatsAppUser('15550001111', 'Local', 'owner@example.com')).toBe(false);
    expect(db.prepare('SELECT enabled, added_by, claim_id FROM portal_whatsapp_access WHERE number = ?').get('15550001111'))
      .toMatchObject({ enabled: 0, added_by: 'member@example.com', claim_id: 'claim' });
    expect(await importLocalWhatsAppUser('15550002222', 'Local', 'owner@example.com')).toBe(true);
  });
  it('claims a queued command once even with stale previous coordination rows', async () => {
    db.prepare(`INSERT INTO portal_bot_failover VALUES ('whatsapp', 'old', 'instance', ?, 8)`).run(Date.now() + 60_000);
    db.prepare(`INSERT INTO portal_bot_commands VALUES (?, 'pair', '{}', 'pending', NULL, NULL, '', ?, ?)`)
      .run('command-1', Date.now(), Date.now() + 60_000);
    db.prepare(`INSERT INTO portal_bot_commands VALUES (?, 'restart', '{}', 'pending', NULL, NULL, '', ?, ?)` )
      .run('old-power', Date.now() - 1, Date.now() + 60_000);
    const [a, b] = await Promise.all([claimPendingBotCommands(), claimPendingBotCommands()]);
    expect([...a, ...b].map((c) => c.id)).toEqual(['command-1']);
    await completeBotCommand({ id: 'command-1', ok: true, result: { first: true } });
    await completeBotCommand({ id: 'command-1', ok: false });
    expect(db.prepare("SELECT status, result_json FROM portal_bot_commands WHERE id='command-1'").get()).toMatchObject({ status: 'completed', result_json: expect.stringContaining('first') });
    expect(db.prepare("SELECT status FROM portal_bot_commands WHERE id='old-power'").get()).toMatchObject({ status: 'pending' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM portal_bot_failover').get()).toMatchObject({ n: 1 });
  });
});
