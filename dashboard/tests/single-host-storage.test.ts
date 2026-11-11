// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_BASE_URL, DEFAULT_PANEL_SERVER_ID } from '../lib/panel-config';
import { cancelPendingWhatsAppUser, claimPairCooldown, claimPendingBotCommands, completeBotCommand, deleteWhatsAppUserIfOwned, getBotConnectionConfig, getBotHeartbeat, getPanelConnectionConfig,
  listConfirmedMemberLinks, releaseClaimedBotCommands, saveBotConnectionConfig, saveBotHeartbeat,
  saveBotHeartbeatIfNewer, saveConfirmedMemberLinks, savePanelConnectionConfig, sessionBackupClaim, getStoredWhatsAppUser, resolvePendingWhatsAppUser } from '../lib/storage';
import type { ApprovedUser, ConfirmedMemberLink } from '../lib/types';

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE portal_bot_commands (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error_text TEXT, requested_by TEXT, created_at INTEGER, expires_at INTEGER);
    CREATE TABLE portal_whatsapp_access (number TEXT PRIMARY KEY, label TEXT, enabled INTEGER, added_by TEXT,
      added_at TEXT, approval_status TEXT, claim_id TEXT);
    CREATE TABLE portal_member_permissions (email TEXT PRIMARY KEY, name TEXT, allowed INTEGER, updated_at TEXT);
    CREATE TABLE portal_session_backups (slot TEXT PRIMARY KEY, generation TEXT, claim_token TEXT, revision INTEGER, ciphertext TEXT, revoked INTEGER, updated_at INTEGER);
    CREATE TABLE portal_pair_cooldowns (number TEXT PRIMARY KEY, retry_at INTEGER NOT NULL);
    CREATE TABLE portal_bot_failover (id TEXT PRIMARY KEY, owner_role TEXT, owner_instance TEXT, expires_at INTEGER, epoch INTEGER);`);
  globalThis.__zafarD1SchemaV6Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test'); vi.stubEnv('D1_DATABASE_ID', 'test'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  for (const key of ['BOT_SYNC_TOKEN', 'ADMIN_DASHBOARD_TOKEN', 'BOT_BOTKEEP_SYNC_TOKEN', 'BOTKEEP_BOT_API_URL', 'BOTKEEP_BOT_ADMIN_TOKEN', 'HIDENCLOUD_SERVER_ID', 'HIDENCLOUD_API_KEY', 'BOTKEEP_WORKLOAD_ID', 'BOTKEEP_API_KEY']) vi.stubEnv(key, '');
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
    expect(await getPanelConnectionConfig()).toMatchObject({ panelUrl: PANEL_BASE_URL, panelServerId: DEFAULT_PANEL_SERVER_ID, panelApiKey: '' });
    // Only the single shared sync token survives; no inbound URL or admin token.
    expect(await getBotConnectionConfig()).toMatchObject({ botSyncToken: 'current-sync-secret' });
    expect(await getBotConnectionConfig()).not.toHaveProperty('botApiUrl');
    expect(await getBotConnectionConfig()).not.toHaveProperty('botAdminToken');
    await savePanelConnectionConfig({ panelServerId: 'workload-1', panelApiKey: 'botkeep-key-123456789' });
    expect(await getPanelConnectionConfig()).toMatchObject({ panelUrl: PANEL_BASE_URL, panelServerId: 'workload-1', panelApiKey: 'botkeep-key-123456789' });
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'panel_api_key'").get()).toMatchObject({ value: 'old-key' });
  });
  it('does not misreport the previous host heartbeat as Botkeep', async () => {
    setting('bot_heartbeat_json', JSON.stringify({ lastSeenAt: Date.now(), connected: true, botNumber: '15550009999' }));
    expect(await getBotHeartbeat()).toBeNull();
    await saveBotHeartbeat({ lastSeenAt: Date.now(), connected: false, botNumber: null });
    expect(await getBotHeartbeat()).toMatchObject({ connected: false });
    expect(db.prepare("SELECT value FROM portal_settings WHERE key = 'bot_heartbeat_json'").get()).toBeTruthy();
  });
  it('does not replace a newer heartbeat with a delayed older poll', async () => {
    const now = Date.now();
    await saveBotHeartbeatIfNewer({ lastSeenAt: now, connected: false, botNumber: null });
    await saveBotHeartbeatIfNewer({ lastSeenAt: now - 1_000, connected: true, botNumber: '15550009999' });
    expect(await getBotHeartbeat()).toMatchObject({ lastSeenAt: now, connected: false, botNumber: null });
    await saveBotHeartbeatIfNewer({ lastSeenAt: now + 1, connected: true, botNumber: '15550009999' });
    expect(await getBotHeartbeat()).toMatchObject({ lastSeenAt: now + 1, connected: true });
    await saveBotHeartbeat({ lastSeenAt: now + 600_000, connected: true, botNumber: null });
    expect(await getBotHeartbeat()).toBeNull();
    await saveBotHeartbeatIfNewer({ lastSeenAt: now + 2, connected: false, botNumber: null });
    expect(await getBotHeartbeat()).toMatchObject({ lastSeenAt: now + 2, connected: false });
  });
  it('ignores retired bridge and Botkeep token settings', async () => {
    vi.stubEnv('BOTKEEP_BOT_API_URL', 'https://botkeep-service.example');
    vi.stubEnv('BOTKEEP_BOT_ADMIN_TOKEN', 'new-bridge-token');
    vi.stubEnv('ADMIN_DASHBOARD_TOKEN', 'legacy-admin-env');
    vi.stubEnv('BOT_BOTKEEP_SYNC_TOKEN', 'botkeep-env-sync');
    setting('bot_admin_token', 'legacy-admin-sync');
    setting('bot_botkeep_sync_token', 'botkeep-saved-sync');
    setting('botkeep_bot_api_url', 'https://botkeep-service.example');
    setting('botkeep_bot_admin_token', 'new-bridge-token');
    expect(await getBotConnectionConfig()).toMatchObject({ botSyncToken: '' });
  });
  it('resolves the sync token from the saved value or BOT_SYNC_TOKEN only', async () => {
    vi.stubEnv('BOT_SYNC_TOKEN', 'env-sync');
    expect((await getBotConnectionConfig()).botSyncToken).toBe('env-sync');
    setting('bot_sync_token', 'explicit-single-host');
    expect((await getBotConnectionConfig()).botSyncToken).toBe('explicit-single-host');
    await saveBotConnectionConfig({ botSyncToken: 'rotated-sync' });
    expect((await getBotConnectionConfig()).botSyncToken).toBe('rotated-sync');
    db.prepare('DELETE FROM portal_settings').run();
    expect((await getBotConnectionConfig()).botSyncToken).toBe('env-sync');
  });
  it('preserves independent settings on simultaneous updates', async () => {
    await Promise.all([
      saveBotConnectionConfig({ botSyncToken: 'new-sync-token' }),
      saveBotConnectionConfig({ botEnabledForMembers: false }),
      savePanelConnectionConfig({ panelServerId: 'workload-new' }),
      savePanelConnectionConfig({ panelApiKey: 'botkeep-api-key-123456' }),
    ]);
    expect(await getBotConnectionConfig()).toMatchObject({ botSyncToken: 'new-sync-token', botEnabledForMembers: false });
    expect(await getPanelConnectionConfig()).toMatchObject({ panelServerId: 'workload-new', panelApiKey: 'botkeep-api-key-123456' });
  });
  it('maps pending, approved, rejected and legacy D1 rows correctly', async () => {
    const insert = db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, 'Member', ?, 'member@example.com', '2026-01-01', ?, 'claim')`);
    insert.run('15550001111', 1, 'pending');
    insert.run('15550002222', 1, 'rejected');
    insert.run('15550003333', 1, null);
    expect(await getStoredWhatsAppUser('15550001111')).toMatchObject({ approval: 'pending', enabled: false, pairAllowed: true });
    expect(await getStoredWhatsAppUser('15550002222')).toMatchObject({ approval: 'rejected', enabled: false, pairAllowed: false });
    expect(await getStoredWhatsAppUser('15550003333')).toMatchObject({ approval: 'approved', enabled: true, pairAllowed: false });
    expect(await resolvePendingWhatsAppUser('15550001111', 'member@example.com', true, 'claim'))
      .toMatchObject({ approval: 'approved', enabled: true });
  });
  it('stores independently claimed links in batches, without creating a heartbeat', async () => {
    const users: ApprovedUser[] = Array.from({ length: 20 }, (_, i) => ({ number: `26599${String(i).padStart(7, '0')}`,
      label: `Member ${i}`, enabled: false, approval: 'pending', addedBy: `member${i}@example.com`,
      addedAt: '2026-01-01T00:00:00.000Z', claimId: `claim-${i}` }));
    for (const user of users) db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, ?, 0, ?, ?, 'pending', ?)`)
      .run(user.number, user.label!, user.addedBy!, user.addedAt!, user.claimId!);
    const links: ConfirmedMemberLink[] = users.map((user, i) => ({ number: user.number, sessionId: i.toString(16).padStart(24, '0'),
      claimToken: sessionBackupClaim(user).token, observedAt: Date.now() - 1_000, linkedAt: Date.now() - 2_000 }));
    await Promise.all([saveConfirmedMemberLinks(links.slice(0, 17), users), saveConfirmedMemberLinks(links.slice(17), users)]);
    expect(await listConfirmedMemberLinks(users)).toHaveLength(20);
    expect(await getBotHeartbeat()).toBeNull();

    // A slow old observation must not replace a newer generation.
    const newer = { ...links[0], sessionId: 'f'.repeat(24), observedAt: Date.now() };
    await saveConfirmedMemberLinks([newer], users);
    await saveConfirmedMemberLinks([links[0]], users);
    expect((await listConfirmedMemberLinks([users[0]]))[0].sessionId).toBe(newer.sessionId);
  });
  it('removes link evidence on unlink and rejects a delayed write after a claim transfer', async () => {
    const old: ApprovedUser = { number: '265991234567', label: 'Old', enabled: true, approval: 'approved',
      addedBy: 'old@example.com', addedAt: '2026-01-01', claimId: 'old-claim' };
    db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, ?, 1, ?, ?, 'approved', ?)`)
      .run(old.number, old.label!, old.addedBy!, old.addedAt!, old.claimId!);
    const evidence: ConfirmedMemberLink = { number: old.number, sessionId: 'a'.repeat(24),
      claimToken: sessionBackupClaim(old).token, observedAt: Date.now() };
    await saveConfirmedMemberLinks([evidence], [old]);
    expect(await listConfirmedMemberLinks([old])).toHaveLength(1);
    expect(await deleteWhatsAppUserIfOwned(old.number, old.addedBy!, old.claimId)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM portal_settings WHERE key LIKE 'member_confirmed_link:%'").get()).toMatchObject({ n: 0 });
    const next = { ...old, addedBy: 'new@example.com', claimId: 'new-claim' };
    db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, ?, 1, ?, ?, 'approved', ?)`)
      .run(next.number, next.label!, next.addedBy!, next.addedAt!, next.claimId!);
    await saveConfirmedMemberLinks([evidence], [old]);
    expect(await listConfirmedMemberLinks([old, next])).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM portal_settings WHERE key LIKE 'member_confirmed_link:%'").get()).toMatchObject({ n: 0 });
  });
  it('atomically excludes cancellation and a new pairing attempt for the same pending claim', async () => {
    const number = '265991234567', owner = 'member@example.com', key = 'pending-claim', now = Date.now();
    const add = () => db.prepare(`INSERT INTO portal_whatsapp_access VALUES (?, 'Member', 0, ?, '2026-01-01', 'pending', ?)`)
      .run(number, owner, key);
    add();
    expect(await cancelPendingWhatsAppUser(number, owner, key, now)).toBe(true);
    expect((await claimPairCooldown(number, now, { key, owner })).ok).toBe(false);
    add();
    expect((await claimPairCooldown(number, now, { key, owner })).ok).toBe(true);
    expect(await cancelPendingWhatsAppUser(number, owner, key, now)).toBe(false);
    expect(db.prepare('SELECT claim_id FROM portal_whatsapp_access WHERE number = ?').get(number)).toMatchObject({ claim_id: key });
  });
  it('releases only unexpired claims belonging to an undelivered response', async () => {
    const statement = db.prepare(`INSERT INTO portal_bot_commands VALUES (?, 'pair', '{}', ?, NULL, NULL, '', ?, ?)`);
    statement.run('own', 'claimed', Date.now(), Date.now() + 60_000);
    statement.run('other', 'claimed', Date.now(), Date.now() + 60_000);
    statement.run('finished', 'completed', Date.now(), Date.now() + 60_000);
    statement.run('expired', 'claimed', Date.now() - 60_000, Date.now() - 1);
    await releaseClaimedBotCommands(['own', 'finished', 'expired']);
    expect(db.prepare('SELECT id, status FROM portal_bot_commands ORDER BY id').all()).toEqual([
      { id: 'expired', status: 'claimed' }, { id: 'finished', status: 'completed' },
      { id: 'other', status: 'claimed' }, { id: 'own', status: 'pending' },
    ]);
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
