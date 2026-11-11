import type { BotConnectionConfig, PanelConnectionConfig } from '../types';
import { PANEL_BASE_URL, DEFAULT_PANEL_SERVER_ID } from '../panel-config';
import { queryD1, requireD1 } from './d1';

export async function getSettingValue(key: string): Promise<string | null> {
  await requireD1();
  const rows = (await queryD1(
    `SELECT value FROM portal_settings WHERE key = ? LIMIT 1`,
    [key],
  )) || [];
  return rows.length > 0 && rows[0].value != null ? String(rows[0].value) : null;
}

export async function setSettingValue(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await requireD1();
  const rows = await queryD1(
    `INSERT INTO portal_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
  if (rows !== null) return;
}

export async function getBotConnectionConfig(): Promise<BotConnectionConfig> {
  // One credential: the shared secret the bot signs its outbound sync with.
  // A value saved in the dashboard wins over the environment variable so the
  // owner can rotate it without redeploying; nothing else is consulted.
  const envSyncToken = process.env.BOT_SYNC_TOKEN?.trim() || '';

  await requireD1();
  const rows = (await queryD1(`SELECT key, value, updated_at FROM portal_settings WHERE key IN
    ('bot_sync_token', 'bot_enabled_for_members')`)) || [];
  const map = new Map<string, string>();
  let updatedAt: string | undefined;
  for (const r of rows) {
    map.set(String(r.key), String(r.value));
    if (r.updated_at) updatedAt = String(r.updated_at);
  }
  return {
    botSyncToken: (map.get('bot_sync_token') || envSyncToken).trim(),
    botEnabledForMembers: map.get('bot_enabled_for_members') !== '0',
    updatedAt,
  };
}

export async function saveBotConnectionConfig(patch: {
  botSyncToken?: string;
  botEnabledForMembers?: boolean;
}): Promise<BotConnectionConfig> {
  const current = await getBotConnectionConfig();
  const nextSyncToken =
    typeof patch.botSyncToken === 'string'
      ? patch.botSyncToken.trim()
      : current.botSyncToken;
  const nextEnabled =
    typeof patch.botEnabledForMembers === 'boolean'
      ? patch.botEnabledForMembers
      : current.botEnabledForMembers;
  const now = new Date().toISOString();
  const entries: [string, string][] = [];
  if (typeof patch.botSyncToken === 'string') entries.push(['bot_sync_token', nextSyncToken]);
  if (typeof patch.botEnabledForMembers === 'boolean') entries.push(['bot_enabled_for_members', nextEnabled ? '1' : '0']);
  const result = { botSyncToken: nextSyncToken, botEnabledForMembers: nextEnabled, updatedAt: now };

  await requireD1();
  if (!entries.length) return result;
  const values = entries.flatMap(([key, value]) => [key, value, now]);
  await queryD1(`INSERT INTO portal_settings (key, value, updated_at)
    VALUES ${entries.map(() => '(?, ?, ?)').join(', ')}
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, values);
  return result;
}

// ============================================================================
// Stored WhatsApp Numbers CRUD (Scoped & Global)
// ============================================================================

/** HiddenCloud panel credentials have a separate namespace; older panels are never used.
 *  HiddenCloud client API keys are ptlc_...; the server ID defaults to the
 *  hardcoded troyzafarings Free Server identifier (DEFAULT_PANEL_SERVER_ID).
 *  The D1/disk keys keep their historical names so an already-saved key survives. */
export async function getPanelConnectionConfig(): Promise<PanelConnectionConfig> {
  const envId = (process.env.HIDENCLOUD_SERVER_ID || process.env.BOTKEEP_WORKLOAD_ID || '').trim();
  const envKey = (process.env.HIDENCLOUD_API_KEY || process.env.BOTKEEP_API_KEY || '').trim();
  await requireD1();
  const rows = (await queryD1(`SELECT key, value, updated_at FROM portal_settings
    WHERE key IN ('botkeep_workload_id', 'botkeep_api_key')`)) || [];
  const map = new Map(rows.map((row) => [String(row.key), String(row.value)]));
  const savedId = map.has('botkeep_workload_id') ? map.get('botkeep_workload_id')! : envId || DEFAULT_PANEL_SERVER_ID;
  return {
    panelUrl: PANEL_BASE_URL,
    panelServerId: savedId.trim(),
    panelApiKey: (map.has('botkeep_api_key') ? map.get('botkeep_api_key')! : envKey).trim(),
    updatedAt: rows.find((row) => row.updated_at)?.updated_at as string | undefined,
  };
}

export async function savePanelConnectionConfig(patch: {
  panelServerId?: string;
  panelApiKey?: string;
}): Promise<PanelConnectionConfig> {
  const current = await getPanelConnectionConfig();
  const nextId = typeof patch.panelServerId === 'string' ? patch.panelServerId.trim() : current.panelServerId;
  const nextKey = typeof patch.panelApiKey === 'string' ? patch.panelApiKey.trim() : current.panelApiKey;
  const now = new Date().toISOString();
  const entries: [string, string][] = [];
  if (typeof patch.panelServerId === 'string') entries.push(['botkeep_workload_id', nextId]);
  if (typeof patch.panelApiKey === 'string') entries.push(['botkeep_api_key', nextKey]);
  const result = { panelUrl: PANEL_BASE_URL, panelServerId: nextId, panelApiKey: nextKey, updatedAt: now };
  await requireD1();
  if (!entries.length) return result;
  await queryD1(`INSERT INTO portal_settings (key, value, updated_at)
    VALUES ${entries.map(() => '(?, ?, ?)').join(', ')}
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    entries.flatMap(([key, value]) => [key, value, now]));
  return result;
}

// Link evidence is stored per ownership claim, separately from the heartbeat.
// Independent rows cannot overwrite another member's link during concurrent polls.
