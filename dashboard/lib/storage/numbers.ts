import crypto from 'node:crypto';
import type { ApprovedUser } from '../types';
import type { SessionBackupClaim } from './backups';
import { claimFromRow, revokeBackupForClaim } from './backups';
import { deleteConfirmedMemberLink } from './links';
import { queryD1, requireD1 } from './d1';

export function numberApproval(value: unknown): ApprovedUser['approval'] {
  // Rows from before this feature had no approval field and retain access.
  if (value == null || value === 'approved') return 'approved';
  return value === 'pending' ? 'pending' : 'rejected';
}

function mapNumberRow(row: Record<string, unknown>): ApprovedUser {
  const approval = numberApproval(row.approval_status);
  return {
    number: String(row.number),
    label: String(row.label || 'Approved number'),
    enabled: approval === 'approved' && Boolean(Number(row.enabled)) && Boolean(Number(row.owner_allowed ?? 1)),
    approval,
    pairAllowed: approval === 'pending' && Boolean(Number(row.owner_allowed ?? 1)),
    addedBy: row.added_by ? String(row.added_by) : undefined,
    claimId: row.claim_id ? String(row.claim_id) : undefined,
    addedAt: String(row.added_at),
  };
}

const SELECT_WHATSAPP_USERS = `SELECT u.number, u.label, u.enabled, u.added_by, u.added_at, u.approval_status, u.claim_id,
  COALESCE(p.allowed, 1) AS owner_allowed FROM portal_whatsapp_access u
  LEFT JOIN portal_member_permissions p ON lower(p.email) = lower(u.added_by)`;

export async function listStoredWhatsAppUsers(ownerEmail?: string): Promise<ApprovedUser[]> {
  const filterOwner = ownerEmail?.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(
    `${SELECT_WHATSAPP_USERS} ${filterOwner ? 'WHERE lower(u.added_by) = ?' : ''} ORDER BY u.added_at DESC`,
    filterOwner ? [filterOwner] : [],
  );
  return (rows || []).map(mapNumberRow);
}

export async function getStoredWhatsAppUser(number: string): Promise<ApprovedUser | null> {
  await requireD1();
  const rows = await queryD1(`${SELECT_WHATSAPP_USERS} WHERE u.number = ? LIMIT 1`, [number]);
  return rows?.length ? mapNumberRow(rows[0]) : null;
}

/** Owner-added numbers are explicitly approved. */

/** Owner-added numbers are explicitly approved. */
export async function saveStoredWhatsAppUser(number: string, label: string, addedBy: string): Promise<ApprovedUser[]> {
  const now = new Date().toISOString();
  const cleanOwner = addedBy.trim().toLowerCase();
  await requireD1();
  await queryD1(
    `INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at, approval_status, claim_id)
     VALUES (?, ?, 1, ?, ?, 'approved', ?)
     ON CONFLICT(number) DO UPDATE SET enabled = 1, label = excluded.label,
       claim_id = portal_whatsapp_access.claim_id,
       added_by = excluded.added_by, approval_status = 'approved'`,
    [number, label, cleanOwner, now, crypto.randomUUID()],
  );
  return listStoredWhatsAppUsers();
}

/** Claim a new number as pending; a member cannot re-enable or transfer it. */

/** Claim a new number as pending; a member cannot re-enable or transfer it. */
export async function saveMemberWhatsAppUser(number: string, label: string, addedBy: string): Promise<boolean> {
  const owner = addedBy.trim().toLowerCase();
  const now = new Date().toISOString();
  await requireD1();
  const rows = await queryD1(
    `INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at, approval_status, claim_id)
     SELECT ?, ?, 0, ?, ?, 'pending', ?
     WHERE NOT EXISTS (SELECT 1 FROM portal_whatsapp_access
       WHERE lower(added_by) = ? AND approval_status = 'pending' AND number != ?)
     ON CONFLICT(number) DO UPDATE SET label = excluded.label
     WHERE lower(portal_whatsapp_access.added_by) = ?
     RETURNING number`,
    [number, label, owner, now, crypto.randomUUID(), owner, number, owner],
  );
  return Boolean(rows?.length);
}

export async function updateStoredWhatsAppUser(
  number: string,
  patch: { enabled?: boolean; label?: string; approval?: ApprovedUser['approval'] },
): Promise<ApprovedUser | null> {
  await requireD1();
  const current = await getStoredWhatsAppUser(number);
  if (!current) return null;
  const approval = patch.approval ?? current.approval ?? 'approved';
  const enabled = approval === 'approved' && (typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled);
  const label = typeof patch.label === 'string' && patch.label.trim()
    ? patch.label.trim().slice(0, 80) : current.label || 'Approved number';
  await queryD1(
    `UPDATE portal_whatsapp_access SET enabled = ?, label = ?, approval_status = ? WHERE number = ?`,
    [enabled ? 1 : 0, label, approval, number],
  );
  return getStoredWhatsAppUser(number);
}

/** Resolve only the same pending claim, even if it was removed concurrently. */

/** Resolve only the same pending claim, even if it was removed concurrently. */
export async function resolvePendingWhatsAppUser(number: string, owner: string, approve: boolean, expectedClaim?: string): Promise<ApprovedUser | null> {
  const email = owner.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(
    `UPDATE portal_whatsapp_access SET approval_status = ?, enabled = ?
     WHERE number = ? AND lower(added_by) = ? AND approval_status = 'pending'
       AND (? IS NULL OR COALESCE(claim_id, '') = ?)
       AND (? = 0 OR COALESCE((SELECT allowed FROM portal_member_permissions WHERE lower(email) = ?), 1) = 1)
     RETURNING number`,
    [approve ? 'approved' : 'rejected', approve ? 1 : 0, number, email, expectedClaim ?? null, expectedClaim ?? null, approve ? 1 : 0, email],
  );
  return rows?.length ? getStoredWhatsAppUser(number) : null;
}

export async function deleteStoredWhatsAppUser(
  number: string,
): Promise<ApprovedUser[]> {
  await requireD1();
  const rows = await queryD1(`DELETE FROM portal_whatsapp_access WHERE number = ? RETURNING claim_id, added_at, added_by`, [number]);
  if (rows?.length) {
    const claim = claimFromRow(rows[0]);
    await revokeBackupForClaim(`linked:${number}`, claim);
    await deleteConfirmedMemberLink(number, claim);
  }
  return listStoredWhatsAppUsers();
}

/** Three-minute resend protection, keyed by phone and atomic across D1 workers. */

/** Three-minute resend protection, keyed by phone and atomic across D1 workers. */
export async function claimPairCooldown(number: string, now = Date.now(), claim?: SessionBackupClaim): Promise<{ ok: boolean; retryAt: number }> {
  const retryAt = now + 180_000;
  await requireD1();
  const guard = `EXISTS (SELECT 1 FROM portal_whatsapp_access WHERE number = ?
    AND COALESCE(claim_id, '') = ? AND lower(COALESCE(added_by, '')) = ?)`;
  const guardParams = claim ? [number, claim.key, claim.owner] : [];
  const rows = await queryD1(
    claim ? `INSERT INTO portal_pair_cooldowns (number, retry_at) SELECT ?, ? WHERE ${guard}
      ON CONFLICT(number) DO UPDATE SET retry_at = excluded.retry_at
      WHERE portal_pair_cooldowns.retry_at <= ? AND ${guard} RETURNING retry_at`
      : `INSERT INTO portal_pair_cooldowns (number, retry_at) VALUES (?, ?)
      ON CONFLICT(number) DO UPDATE SET retry_at = excluded.retry_at
      WHERE portal_pair_cooldowns.retry_at <= ? RETURNING retry_at`,
    claim ? [number, retryAt, ...guardParams, now, ...guardParams] : [number, retryAt, now],
  );
  if (rows?.length) return { ok: true, retryAt };
  return { ok: false, retryAt: await getPairCooldown(number) };
}

export async function getPairCooldown(number: string): Promise<number> {
  await requireD1();
  const rows = await queryD1(`SELECT retry_at FROM portal_pair_cooldowns WHERE number = ?`, [number]);
  return Number(rows?.[0]?.retry_at) || 0;
}

/** Release only our own attempt when no pairing request was accepted. */

/** Release only our own attempt when no pairing request was accepted. */
export async function releasePairCooldown(number: string, retryAt: number): Promise<void> {
  await requireD1();
  await queryD1(`DELETE FROM portal_pair_cooldowns WHERE number = ? AND retry_at = ?`, [number, retryAt]);
  return;
}

/** Remove only a number still owned by the caller, even after a queued unlink. */

/** Remove only a number still owned by the caller, even after a queued unlink. */
export async function deleteWhatsAppUserIfOwned(number: string, ownerEmail: string, expectedClaim?: string): Promise<boolean> {
  const owner = ownerEmail.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(
    `DELETE FROM portal_whatsapp_access WHERE number = ? AND lower(added_by) = ?
     AND (? IS NULL OR COALESCE(claim_id, '') = ?) RETURNING claim_id, added_at, added_by`,
    [number, owner, expectedClaim ?? null, expectedClaim ?? null],
  );
  if (rows?.length) {
    const claim = claimFromRow(rows[0]);
    await revokeBackupForClaim(`linked:${number}`, claim);
    await deleteConfirmedMemberLink(number, claim);
  }
  return Boolean(rows?.length);
}

/** Remove an unlinked pending claim only when no pairing attempt is active. */

/** Remove an unlinked pending claim only when no pairing attempt is active. */
export async function cancelPendingWhatsAppUser(number: string, ownerEmail: string, expectedClaim: string, now = Date.now()): Promise<boolean> {
  const owner = ownerEmail.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(`DELETE FROM portal_whatsapp_access WHERE number = ? AND lower(added_by) = ?
    AND approval_status = 'pending' AND COALESCE(claim_id, '') = ?
    AND NOT EXISTS (SELECT 1 FROM portal_pair_cooldowns WHERE number = ? AND retry_at > ?)
    RETURNING claim_id, added_at, added_by`, [number, owner, expectedClaim, number, now]);
  if (rows?.length) {
    const claim = claimFromRow(rows[0]);
    await revokeBackupForClaim(`linked:${number}`, claim);
    await deleteConfirmedMemberLink(number, claim);
  }
  return Boolean(rows?.length);
}

// ============================================================================
// Bot Heartbeat, Versioned Whitelist, Command Queue & Panel Config
// ============================================================================
