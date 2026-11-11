import type { MemberRecord } from '../types';
import { queryD1, requireD1 } from './d1';
import { listStoredWhatsAppUsers } from './numbers';

export async function isMemberEmailAllowed(email: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  if (!clean) return false;

  await requireD1();
  const rows = await queryD1(
    `SELECT allowed FROM portal_member_permissions WHERE email = ? LIMIT 1`,
    [clean],
  );
  if (rows && rows.length > 0) {
    return Boolean(Number(rows[0].allowed));
  }
  return true;
}

export async function setMemberPermission(
  email: string,
  allowed: boolean,
  name = '',
): Promise<void> {
  const clean = email.trim().toLowerCase();
  const now = new Date().toISOString();

  await requireD1();
  await queryD1(
    `INSERT INTO portal_member_permissions (email, name, allowed, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       allowed = excluded.allowed,
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE portal_member_permissions.name END,
       updated_at = excluded.updated_at`,
    [clean, name.trim(), allowed ? 1 : 0, now],
  );

  // Sync all WhatsApp numbers belonging to this member automatically
  await queryD1(
    `UPDATE portal_whatsapp_access SET enabled = CASE WHEN approval_status = 'approved' THEN ? ELSE 0 END WHERE lower(added_by) = ?`,
    [allowed ? 1 : 0, clean],
  );
  return;
}

export async function listAllMembers(
  checkAdmin: (email: string) => boolean,
): Promise<MemberRecord[]> {
  const whatsappAll = await listStoredWhatsAppUsers();
  const countByEmail = new Map<string, number>();
  for (const item of whatsappAll) {
    const owner = (item.addedBy || '').toLowerCase();
    if (owner) countByEmail.set(owner, (countByEmail.get(owner) || 0) + 1);
  }

  const merged = new Map<string, MemberRecord>();

  await requireD1();
  const permRows =
    (await queryD1(
      `SELECT email, name, allowed, updated_at FROM portal_member_permissions`,
    )) || [];
  const permMap = new Map<string, { allowed: boolean; name: string; updatedAt: string }>();
  for (const r of permRows) {
    const em = String(r.email || '').toLowerCase();
    if (em) {
      permMap.set(em, {
        allowed: Boolean(Number(r.allowed)),
        name: String(r.name || ''),
        updatedAt: String(r.updated_at || new Date().toISOString()),
      });
    }
  }

  const portalRows =
    (await queryD1(
      `SELECT email, name, is_verified, created_at FROM portal_accounts ORDER BY created_at DESC`,
    )) || [];
  for (const r of portalRows) {
    const em = String(r.email || '').toLowerCase();
    if (!em) continue;
    const perm = permMap.get(em);
    merged.set(em, {
      email: em,
      name: String(r.name || perm?.name || em.split('@')[0]),
      isVerified: Boolean(Number(r.is_verified)),
      isAdmin: checkAdmin(em),
      allowed: checkAdmin(em) ? true : perm ? perm.allowed : true,
      numbersCount: countByEmail.get(em) || 0,
      createdAt: String(r.created_at || new Date().toISOString()),
    });
  }

  try {
    const backendRows =
      (await queryD1(
        `SELECT email, name, username, is_verified, created_at FROM users WHERE email IS NOT NULL ORDER BY created_at DESC`,
      )) || [];
    for (const r of backendRows) {
      const em = String(r.email || '').toLowerCase();
      if (!em || merged.has(em)) continue;
      const perm = permMap.get(em);
      merged.set(em, {
        email: em,
        name: String(r.name || r.username || perm?.name || em.split('@')[0]),
        isVerified: Boolean(Number(r.is_verified ?? 1)),
        isAdmin: checkAdmin(em),
        allowed: checkAdmin(em) ? true : perm ? perm.allowed : true,
        numbersCount: countByEmail.get(em) || 0,
        createdAt: String(r.created_at || new Date().toISOString()),
      });
    }
  } catch {
    // ignore if `users` table does not exist
  }

  for (const [em, perm] of permMap.entries()) {
    if (!merged.has(em)) {
      merged.set(em, {
        email: em,
        name: perm.name || em.split('@')[0],
        isVerified: false,
        isAdmin: checkAdmin(em),
        allowed: checkAdmin(em) ? true : perm.allowed,
        numbersCount: countByEmail.get(em) || 0,
        createdAt: perm.updatedAt,
      });
    }
  }

  return Array.from(merged.values());
}

// ============================================================================
// Server-Side Bot Connection & Global Switch Settings
// ============================================================================
