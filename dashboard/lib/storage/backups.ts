import crypto from 'node:crypto';
import type { ApprovedUser } from '../types';
import { DEFAULT_PANEL_SERVER_ID } from '../panel-config';
import { queryD1, requireD1 } from './d1';

export interface SessionBackupRecord { slot: string; generation: string; claimToken: string; revision: number; ciphertext: string; revoked: boolean; updatedAt: number }

function mapSessionBackup(row: Record<string, unknown>): SessionBackupRecord {
  return { slot: String(row.slot), generation: String(row.generation), claimToken: String(row.claim_token || ''), revision: Number(row.revision), ciphertext: String(row.ciphertext || ''), revoked: Boolean(Number(row.revoked)), updatedAt: Number(row.updated_at) };
}
/** Session recovery is deliberately unavailable on the ephemeral disk fallback. */

/** Session recovery is deliberately unavailable on the ephemeral disk fallback. */
async function requireSessionBackupStorage(): Promise<void> {
  await requireD1();
}

function requireBackupRows<T>(rows: T[] | null): T[] {
  if (rows === null) throw new Error('Recovery storage is unavailable.');
  return rows;
}

export async function listSessionBackupMetadata(after = ''): Promise<Omit<SessionBackupRecord, 'ciphertext'>[]> {
  await requireSessionBackupStorage();
  const rows = requireBackupRows(await queryD1(`SELECT slot, generation, claim_token, revision, revoked, updated_at FROM portal_session_backups WHERE slot > ? ORDER BY slot LIMIT 100`, [after]));
  return rows.map((row) => { const { ciphertext: _ciphertext, ...rest } = mapSessionBackup(row); return rest; });
}

export async function getSessionBackup(slot: string): Promise<SessionBackupRecord | null> {
  await requireSessionBackupStorage();
  const rows = requireBackupRows(await queryD1(`SELECT * FROM portal_session_backups WHERE slot = ? LIMIT 1`, [slot]));
  return rows.length ? mapSessionBackup(rows[0]) : null;
}
/** Portal ownership data used to recheck a backup write in the same SQL statement. */

/** Portal ownership data used to recheck a backup write in the same SQL statement. */
export interface SessionBackupClaim { key: string; owner: string }

export function sessionBackupClaim(user: Pick<ApprovedUser, 'claimId' | 'addedAt' | 'addedBy'>): { token: string; identity: SessionBackupClaim } {
  const identity = { key: String(user.claimId || ''), owner: String(user.addedBy || '').toLowerCase() };
  return { token: crypto.createHash('sha256').update(JSON.stringify([identity.key, identity.owner])).digest('hex'), identity };
}

export function claimFromRow(row: Record<string, unknown>): string {
  return sessionBackupClaim({ claimId: row.claim_id ? String(row.claim_id) : undefined,
    addedAt: String(row.added_at || ''), addedBy: row.added_by ? String(row.added_by) : undefined }).token;
}

function backupEligibility(slot: string, identity?: SessionBackupClaim | null): { sql: string; params: string[] } {
  if (slot === 'primary') return { sql: '1 = 1', params: [] };
  if (!identity || !/^linked:\d{7,15}$/.test(slot)) return { sql: '0 = 1', params: [] };
  return { sql: `EXISTS (SELECT 1 FROM portal_whatsapp_access u
    LEFT JOIN portal_member_permissions p ON lower(p.email) = lower(u.added_by)
    WHERE u.number = ? AND COALESCE(u.claim_id, '') = ?
      AND lower(COALESCE(u.added_by, '')) = ? AND COALESCE(p.allowed, 1) = 1
      AND (COALESCE(u.approval_status, 'approved') = 'pending'
        OR (COALESCE(u.approval_status, 'approved') = 'approved' AND u.enabled = 1)))`,
    params: [slot.slice(7), identity.key, identity.owner] };
}
/** Read the backup only if its ownership is still current at the SQL snapshot. */

/** Read the backup only if its ownership is still current at the SQL snapshot. */
export async function getEligibleSessionBackup(slot: string, claimToken: string, identity?: SessionBackupClaim | null): Promise<SessionBackupRecord | null> {
  await requireSessionBackupStorage();
  const check = backupEligibility(slot, identity);
  const rows = requireBackupRows(await queryD1(`SELECT * FROM portal_session_backups WHERE slot = ? AND claim_token = ? AND revoked = 0 AND ${check.sql} LIMIT 1`,
    [slot, claimToken, ...check.params]));
  return rows.length ? mapSessionBackup(rows[0]) : null;
}
/** Compare-and-swap and check the current claim atomically, not in a prior request. */

/** Compare-and-swap and check the current claim atomically, not in a prior request. */
export async function putSessionBackup(slot: string, generation: string, claimToken: string, ciphertext: string, expected: number, identity?: SessionBackupClaim | null): Promise<number | null> {
  await requireSessionBackupStorage();
  const check = backupEligibility(slot, identity);
  const rows = expected === 0
    ? await queryD1(`INSERT INTO portal_session_backups (slot, generation, claim_token, revision, ciphertext, revoked, updated_at)
        SELECT ?, ?, ?, 1, ?, 0, ? WHERE ${check.sql} ON CONFLICT(slot) DO NOTHING RETURNING revision`,
      [slot, generation, claimToken, ciphertext, Date.now(), ...check.params])
    : await queryD1(`UPDATE portal_session_backups SET generation = ?, claim_token = ?, revision = revision + 1, ciphertext = ?, revoked = 0, updated_at = ?
        WHERE slot = ? AND revision = ? AND (revoked = 0 OR generation != ?) AND ${check.sql} RETURNING revision`,
      [generation, claimToken, ciphertext, Date.now(), slot, expected, generation, ...check.params]);
  const result = requireBackupRows(rows);
  return result.length ? Number(result[0].revision) : null;
}
/** A delayed deletion can erase only the deleted owner's backup, never a replacement. */

/** A delayed deletion can erase only the deleted owner's backup, never a replacement. */
export async function revokeBackupForClaim(slot: string, claimToken: string): Promise<void> {
  await requireD1();
  await queryD1(`UPDATE portal_session_backups SET revision = revision + 1, ciphertext = '', revoked = 1, updated_at = ?
    WHERE slot = ? AND claim_token = ?`, [Date.now(), slot, claimToken]);
}

export async function revokeSessionBackup(slot: string, generation?: string): Promise<void> {
  await requireSessionBackupStorage();
  // When a generation is supplied, a delayed logout cannot revoke a newer link.
  if (generation) {
    requireBackupRows(await queryD1(`INSERT INTO portal_session_backups (slot, generation, claim_token, revision, ciphertext, revoked, updated_at) VALUES (?, ?, '', 1, '', 1, ?)
      ON CONFLICT(slot) DO UPDATE SET revision = portal_session_backups.revision + 1, ciphertext = '', revoked = 1, updated_at = excluded.updated_at
      WHERE portal_session_backups.generation = excluded.generation`, [slot, generation, Date.now()]));
  } else {
    requireBackupRows(await queryD1(`INSERT INTO portal_session_backups (slot, generation, claim_token, revision, ciphertext, revoked, updated_at) VALUES (?, '', '', 1, '', 1, ?)
      ON CONFLICT(slot) DO UPDATE SET revision = portal_session_backups.revision + 1, ciphertext = '', revoked = 1, updated_at = excluded.updated_at`, [slot, Date.now()]));
  }
}

/** HiddenCloud panel credentials have a separate namespace; older panels are never used.
 *  HiddenCloud client API keys are ptlc_...; the server ID defaults to the
 *  hardcoded troyzafarings Free Server identifier (DEFAULT_PANEL_SERVER_ID).
 *  The D1/disk keys keep their historical names so an already-saved key survives. */
