// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimFailoverLease, claimPendingBotCommands, completeBotCommand,
  getBotConnectionConfig, getFailoverStatus, getPanelConnectionConfig, importLocalUserForLease, saveBotConnectionConfig, saveBotHeartbeat, savePanelConnectionConfig,
} from '../lib/storage';

let db: DatabaseSync;
const xs = { role: 'xs' as const, instance: 'a'.repeat(32) };
const backup = { role: 'botkeep' as const, instance: 'b'.repeat(32) };
const xsReady = { connected: true, accountNumber: '15550009999', deviceFingerprint: '1'.repeat(64) };
const backupReady = { connected: true, accountNumber: '15550009999', deviceFingerprint: '2'.repeat(64) };

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE portal_bot_failover (id TEXT PRIMARY KEY, owner_role TEXT NOT NULL, owner_instance TEXT NOT NULL,
      expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL);
    CREATE TABLE portal_bot_failover_nodes (role TEXT PRIMARY KEY, instance TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
      connected INTEGER, version TEXT NOT NULL, account_hash TEXT NOT NULL DEFAULT '', device_fingerprint TEXT NOT NULL DEFAULT '');
    CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE portal_bot_commands (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error_text TEXT, requested_by TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE portal_whatsapp_access (number TEXT PRIMARY KEY, label TEXT, enabled INTEGER, added_by TEXT,
      added_at TEXT, approval_status TEXT, claim_id TEXT);
  `);
  globalThis.__zafarD1SchemaV6Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test');
  vi.stubEnv('D1_DATABASE_ID', 'test');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
    try {
      const rows = db.prepare(sql).all(...params);
      return Response.json({ success: true, result: [{ results: rows }] });
    } catch (error) {
      return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 });
    }
  }));
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  globalThis.__zafarD1SchemaV6Ready = undefined;
  globalThis.__zafarD1SchemaV6Promise = undefined;
  globalThis.__zafarD1UnreachableInDev = undefined;
  globalThis.__zafarFailoverSchemaReady = undefined;
  globalThis.__zafarFailoverSchemaPromise = undefined;
});

function expireLease() {
  db.exec("UPDATE portal_bot_failover SET expires_at = 0 WHERE id = 'whatsapp'");
}
function makePrimaryStale() {
  db.exec("UPDATE portal_bot_failover_nodes SET last_seen_at = 0 WHERE role = 'xs'");
}

describe('XS primary panel settings', () => {
  it('does not send an XS environment key to a different saved panel URL', async () => {
    vi.stubEnv('PANEL_URL', 'https://panel.xsystemshosting.com');
    vi.stubEnv('PANEL_SERVER_ID', '381c9516');
    vi.stubEnv('PANEL_API_KEY', 'xs-only-test-key');
    db.prepare('INSERT INTO portal_settings VALUES (?, ?, ?)').run('xs_panel_url', 'https://other.example', '2026-01-01');
    expect(await getPanelConnectionConfig()).toMatchObject({ panelUrl: 'https://other.example', panelApiKey: '' });
  });

  it('defaults to the new XS server without sending legacy Botkeep credentials to it', async () => {
    const insert = db.prepare('INSERT INTO portal_settings VALUES (?, ?, ?)');
    insert.run('panel_url', 'https://panel.botkeep.example', '2026-01-01');
    insert.run('panel_server_id', 'old-server', '2026-01-01');
    insert.run('panel_api_key', 'old-private-key', '2026-01-01');
    expect(await getPanelConnectionConfig()).toMatchObject({
      panelUrl: 'https://panel.xsystemshosting.com', panelServerId: '381c9516', panelApiKey: '',
    });
    await savePanelConnectionConfig({ panelApiKey: 'new-xs-private-key' });
    expect(await getPanelConnectionConfig()).toMatchObject({ panelServerId: '381c9516', panelApiKey: 'new-xs-private-key' });
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'panel_api_key'").get()).toMatchObject({ value: 'old-private-key' });
    await savePanelConnectionConfig({ panelUrl: 'https://another-panel.example' });
    expect(await getPanelConnectionConfig()).toMatchObject({ panelUrl: 'https://another-panel.example', panelApiKey: '' });
  });
});

describe('role-bound sync settings', () => {
  it('saves distinct private host tokens without replacing the legacy single-host token', async () => {
    const xsToken = 'x'.repeat(40); const backupToken = 'b'.repeat(40); const legacy = 'old-single-host-token';
    await saveBotConnectionConfig({ botSyncToken: legacy, botXsSyncToken: xsToken, botBotkeepSyncToken: backupToken });
    expect(await getBotConnectionConfig()).toMatchObject({ botSyncToken: legacy, botXsSyncToken: xsToken, botBotkeepSyncToken: backupToken });
    await saveBotConnectionConfig({ botEnabledForMembers: false });
    expect(await getBotConnectionConfig()).toMatchObject({ botSyncToken: legacy, botXsSyncToken: xsToken, botBotkeepSyncToken: backupToken, botEnabledForMembers: false });
  });

  it('can explicitly clear a host token even if the environment supplies a default', async () => {
    vi.stubEnv('BOT_XS_SYNC_TOKEN', 'x'.repeat(40));
    expect((await getBotConnectionConfig()).botXsSyncToken).toBe('x'.repeat(40));
    await saveBotConnectionConfig({ botXsSyncToken: '' });
    expect((await getBotConnectionConfig()).botXsSyncToken).toBe('');
  });

  it('does not overwrite a host token when independent settings are saved concurrently', async () => {
    await Promise.all([
      saveBotConnectionConfig({ botXsSyncToken: 'x'.repeat(40) }),
      saveBotConnectionConfig({ botBotkeepSyncToken: 'b'.repeat(40) }),
      saveBotConnectionConfig({ botEnabledForMembers: false }),
    ]);
    expect(await getBotConnectionConfig()).toMatchObject({ botXsSyncToken: 'x'.repeat(40), botBotkeepSyncToken: 'b'.repeat(40), botEnabledForMembers: false });
  });

  it('rejects short, overlapping, and environment-derived legacy credentials', async () => {
    const token = 'a'.repeat(40);
    await expect(saveBotConnectionConfig({ botXsSyncToken: 'short' })).rejects.toThrow(/32/);
    await expect(saveBotConnectionConfig({ botXsSyncToken: token, botBotkeepSyncToken: token })).rejects.toThrow(/different/);
    await expect(saveBotConnectionConfig({ botSyncToken: token, botXsSyncToken: token })).rejects.toThrow(/different/);
    vi.stubEnv('ADMIN_DASHBOARD_TOKEN', token);
    await expect(saveBotConnectionConfig({ botBotkeepSyncToken: token })).rejects.toThrow(/different/);
    expect((await getBotConnectionConfig()).botXsSyncToken).toBe('');
  });
});

describe('durable primary/standby lease', () => {
  it('keeps single-host queue and local allow imports working before failover is enabled', async () => {
    db.prepare(`INSERT INTO portal_bot_commands VALUES (?, 'restart', '{}', 'pending', NULL, NULL, '', ?, ?)`)
      .run('legacy', Date.now(), Date.now() + 60_000);
    expect((await claimPendingBotCommands()).map((command) => command.id)).toEqual(['legacy']);
    expect(await importLocalUserForLease('15550004444', 'Local', 'owner@example.com')).toBe(true);
    await completeBotCommand({ id: 'legacy', ok: true });
    expect(db.prepare("SELECT status FROM portal_bot_commands WHERE id = 'legacy'").get()).toMatchObject({ status: 'completed' });
    await saveBotHeartbeat({ lastSeenAt: 123, connected: true, botNumber: null });
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'bot_heartbeat_json'").get()).toBeTruthy();
  });

  it('fails closed without D1 and does not silently expose old direct hosts on an outage', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    await expect(claimFailoverLease(xs, xsReady)).rejects.toThrow(/D1/);
    expect(await getFailoverStatus()).toMatchObject({ enabled: false });
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test');
    globalThis.__zafarD1UnreachableInDev = true;
    await expect(getFailoverStatus()).rejects.toThrow(/unavailable/i);
  });

  it('prefers XS, only lets backup take over after expiry, and safely yields when XS returns', async () => {
    expect(await claimFailoverLease(backup, backupReady)).toMatchObject({ granted: false });
    const first = await claimFailoverLease(xs, { ...xsReady, version: 'test' });
    expect(first).toMatchObject({ granted: true, role: 'xs', instance: xs.instance, epoch: 1, ttlMs: 30_000 });
    expect(await claimFailoverLease(backup, backupReady)).toMatchObject({ granted: false });
    expect(await getFailoverStatus()).toMatchObject({ enabled: true, activeRole: 'xs', xs: { connected: true }, botkeep: { connected: true } });

    makePrimaryStale();
    expect(await claimFailoverLease(backup, backupReady)).toMatchObject({ granted: false });
    expireLease();
    const takeover = await claimFailoverLease(backup, backupReady);
    expect(takeover).toMatchObject({ granted: true, role: 'botkeep', epoch: 2 });

    expect(await claimFailoverLease(xs, xsReady)).toMatchObject({ granted: false });
    expect(await claimFailoverLease(backup, backupReady)).toMatchObject({ granted: false });
    // XS cannot preempt an unexpired lease; the backup must first stop serving
    // and let the prior lease expire.
    expect((await getFailoverStatus())?.activeRole).toBe('botkeep');
    expireLease();
    expect(await claimFailoverLease(xs, xsReady)).toMatchObject({ granted: true, role: 'xs', epoch: 3 });
  });

  it('refuses a copied session or a backup paired to a different WhatsApp number', async () => {
    expect(await claimFailoverLease(xs, xsReady)).toMatchObject({ granted: true });
    makePrimaryStale(); expireLease();
    expect(await claimFailoverLease(backup, { ...backupReady, deviceFingerprint: xsReady.deviceFingerprint })).toMatchObject({ granted: false });
    const conflict = await getFailoverStatus();
    expect(conflict).toMatchObject({ issue: 'shared-session' });
    expect(JSON.stringify(conflict)).not.toContain(xsReady.deviceFingerprint);
    expect(JSON.stringify(conflict)).not.toContain(xsReady.accountNumber);
    expect(await claimFailoverLease(backup, { ...backupReady, accountNumber: '15550008888' })).toMatchObject({ granted: false });
    expect(await getFailoverStatus()).toMatchObject({ issue: 'different-account' });
    expect(await claimFailoverLease(backup, backupReady)).toMatchObject({ granted: true, role: 'botkeep' });
    expect(await getFailoverStatus()).toMatchObject({ issue: null });
  });

  it('fences duplicate processes, stale leases, queue claims and heartbeat writes', async () => {
    const lease = await claimFailoverLease(xs, xsReady);
    expect(lease.granted).toBe(true);
    const identity = { role: xs.role, instance: xs.instance, epoch: lease.epoch! };
    const anotherXs = { role: 'xs' as const, instance: 'c'.repeat(32) };
    expect(await claimFailoverLease(anotherXs, xsReady)).toMatchObject({ granted: false });

    db.prepare(`INSERT INTO portal_bot_commands VALUES (?, 'restart', '{}', 'pending', NULL, NULL, '', ?, ?)`)
      .run('command-1', Date.now(), Date.now() + 60_000);
    expect(await claimPendingBotCommands({ role: 'botkeep', instance: backup.instance, epoch: identity.epoch })).toEqual([]);
    // A legacy request that passed its earlier mode check cannot win a race
    // against a cluster activated before this atomic claim.
    expect(await claimPendingBotCommands()).toEqual([]);
    expect(await importLocalUserForLease('15550003333', 'Late', 'owner@example.com')).toBe(false);
    const [a, b] = await Promise.all([claimPendingBotCommands(identity), claimPendingBotCommands(identity)]);
    expect(a.length + b.length).toBe(1);
    expect([...a, ...b][0].id).toBe('command-1');

    await saveBotHeartbeat({ lastSeenAt: 123, connected: true, botNumber: null }, identity);
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'bot_heartbeat_json'").get()).toBeTruthy();
    await saveBotHeartbeat({ lastSeenAt: 888, connected: true, botNumber: null });
    await completeBotCommand({ id: 'command-1', ok: true });
    expect(db.prepare("SELECT status FROM portal_bot_commands WHERE id = 'command-1'").get()).toMatchObject({ status: 'claimed' });
    expireLease();
    await saveBotHeartbeat({ lastSeenAt: 999, connected: true, botNumber: null }, identity);
    const saved = db.prepare("SELECT value FROM portal_settings WHERE key = 'bot_heartbeat_json'").get() as { value: string };
    expect(JSON.parse(saved.value).lastSeenAt).toBe(123);
    await completeBotCommand({ id: 'command-1', ok: true, result: { ok: true } }, identity);
    expect(db.prepare("SELECT status FROM portal_bot_commands WHERE id = 'command-1'").get()).toMatchObject({ status: 'claimed' });
    expect(await importLocalUserForLease('15550001111', 'Local', 'owner@example.com', identity)).toBe(false);
  });

  it('never restores, overwrites, or transfers an existing dashboard member during local import', async () => {
    const lease = await claimFailoverLease(xs, xsReady);
    const identity = { role: xs.role, instance: xs.instance, epoch: lease.epoch! };
    db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, 'Member', 0, 'member@example.com', '2026-01-01', 'pending', 'claim')`).run('15550001111');
    expect(await importLocalUserForLease('15550001111', 'Local', 'owner@example.com', identity)).toBe(false);
    expect(db.prepare('SELECT enabled, added_by FROM portal_whatsapp_access WHERE number = ?').get('15550001111'))
      .toMatchObject({ enabled: 0, added_by: 'member@example.com' });
    expect(await importLocalUserForLease('15550002222', 'New', 'owner@example.com', identity)).toBe(true);
  });
});
