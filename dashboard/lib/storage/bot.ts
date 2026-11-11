import crypto from 'node:crypto';
import type { ApprovedUser, BotHeartbeatRecord } from '../types';
import { queryD1, requireD1 } from './d1';
import { listStoredWhatsAppUsers, numberApproval } from './numbers';
import { getBotConnectionConfig, getSettingValue, setSettingValue } from './settings';

export async function saveBotHeartbeat(hb: BotHeartbeatRecord): Promise<void> {
  await setSettingValue('botkeep_heartbeat_json', JSON.stringify(hb));
}

/** A delayed overlapping poll must not replace a more recently received status. */

/** A delayed overlapping poll must not replace a more recently received status. */
export async function saveBotHeartbeatIfNewer(hb: BotHeartbeatRecord): Promise<void> {
  const key = 'botkeep_heartbeat_json';
  const value = JSON.stringify(hb);
  await requireD1();
  await queryD1(`INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE CASE WHEN json_valid(portal_settings.value)
      THEN COALESCE(CAST(json_extract(portal_settings.value, '$.lastSeenAt') AS INTEGER), 0) ELSE 0 END <= ?
      OR CASE WHEN json_valid(portal_settings.value)
      THEN COALESCE(CAST(json_extract(portal_settings.value, '$.lastSeenAt') AS INTEGER), 0) ELSE 0 END > ?`,
  [key, value, new Date().toISOString(), hb.lastSeenAt, Date.now() + 60_000]);
  return;
}

/** Reserve a signed-sync nonce durably so parallel dashboard instances share replay protection. */

/** Reserve a signed-sync nonce durably so parallel dashboard instances share replay protection. */
export async function consumeBotSyncNonce(nonce: string, expiresAt: number, now = Date.now()): Promise<boolean> {
  const key = `bot_sync_nonce:${crypto.createHash('sha256').update(nonce).digest('hex')}`;
  await requireD1();
  await queryD1(`DELETE FROM portal_settings WHERE key LIKE 'bot_sync_nonce:%' AND CAST(value AS INTEGER) <= ?`, [now]);
  const rows = await queryD1(`INSERT INTO portal_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING RETURNING key`, [key, String(expiresAt), new Date(now).toISOString()]);
  return Boolean(rows?.length);
}

export async function getBotHeartbeat(): Promise<BotHeartbeatRecord | null> {
  // A previous host's recent heartbeat must not be shown as Botkeep's state.
  const raw = await getSettingValue('botkeep_heartbeat_json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Number.isSafeInteger(parsed.lastSeenAt) || parsed.lastSeenAt <= 0 || parsed.lastSeenAt > Date.now() + 60_000) return null;
    return parsed as BotHeartbeatRecord;
  } catch {
    return null;
  }
}

export async function setFastPollWindow(durationMs = 60_000): Promise<void> {
  const until = Date.now() + Math.max(5_000, durationMs);
  await setSettingValue('bot_fast_poll_until', String(until));
}

export async function getNextBotPollMs(): Promise<number> {
  const raw = await getSettingValue('bot_fast_poll_until');
  const until = raw ? Number(raw) : 0;
  if (until > Date.now()) return 2_000;
  return 10_000;
}

function timestampMilliseconds(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  const text = String(value || '').trim();
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  }
  const parsed = Date.parse(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Exact authoritative whitelist row sent to the bot. */

/** Exact authoritative whitelist row sent to the bot. */
export function serializeWhitelistUsers(users: ApprovedUser[]) {
  return users.map((user) => ({
    number: user.number,
    label: user.label || '',
    addedBy: (user.addedBy || '').trim().toLowerCase(),
    addedAt: timestampMilliseconds(user.addedAt),
    claimId: String(user.claimId || ''),
    enabled: user.enabled === true,
    approval: numberApproval(user.approval) || 'approved',
    ...(user.pairAllowed === true ? { pairAllowed: true } : {}),
  })).sort((a, b) => a.number.localeCompare(b.number));
}

export function whitelistVersionFor(users: ApprovedUser[], _botEnabledForMembers?: boolean): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(serializeWhitelistUsers(users)))
    .digest('hex').slice(0, 16);
}

export async function computeWhitelistSnapshot(): Promise<{
  version: string;
  botEnabledForMembers: boolean;
  users: ApprovedUser[];
  numbers: string[];
}> {
  const [cfg, users] = await Promise.all([
    getBotConnectionConfig(),
    listStoredWhatsAppUsers(),
  ]);
  const serialized = serializeWhitelistUsers(users);
  return {
    version: whitelistVersionFor(users),
    botEnabledForMembers: cfg.botEnabledForMembers,
    users,
    numbers: cfg.botEnabledForMembers ? serialized.filter((user) => user.enabled).map((user) => user.number) : [],
  };
}
