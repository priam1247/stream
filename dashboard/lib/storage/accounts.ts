import { queryD1, requireD1 } from './d1';

export interface StoredPortalAccount {
  id: number;
  email: string;
  username: string;
  name: string;
  passwordHash: string;
  isVerified: boolean;
  verificationCode: string | null;
  codeExpiresAt: string | null;
  verificationAttempts: number;
  resetCode: string | null;
  resetExpiresAt: string | null;
  resetAttempts: number;
  createdAt: string;
}

function mapD1Account(row: Record<string, unknown>): StoredPortalAccount {
  return {
    id: Number(row.id),
    email: String(row.email || ''),
    username: String(row.username || ''),
    name: String(row.name || ''),
    passwordHash: String(row.password_hash || ''),
    isVerified: Boolean(Number(row.is_verified)),
    verificationCode: row.verification_code ? String(row.verification_code) : null,
    codeExpiresAt: row.code_expires_at ? String(row.code_expires_at) : null,
    verificationAttempts: Number(row.verification_attempts || 0),
    resetCode: row.reset_code ? String(row.reset_code) : null,
    resetExpiresAt: row.reset_expires_at ? String(row.reset_expires_at) : null,
    resetAttempts: Number(row.reset_attempts || 0),
    createdAt: String(row.created_at || new Date().toISOString()),
  };
}

export async function findAccountByEmailOrUsername(
  identifier: string,
): Promise<StoredPortalAccount | null> {
  const key = identifier.trim().toLowerCase();

  await requireD1();
  const rows = await queryD1(
    `SELECT * FROM portal_accounts WHERE email = ? OR username = ? LIMIT 1`,
    [key, key],
  );
  if (rows && rows.length > 0) {
    return mapD1Account(rows[0]);
  }

  try {
    const legacy = await queryD1(
      `SELECT id, email, username, name, hashed_password, is_verified, created_at
       FROM users WHERE email = ? OR username = ? LIMIT 1`,
      [key, key],
    );
    if (legacy && legacy.length > 0) {
      const u = legacy[0];
      return {
        id: Number(u.id),
        email: String(u.email || ''),
        username: String(u.username || key),
        name: String(u.name || u.username || 'Member'),
        passwordHash: String(u.hashed_password || ''),
        isVerified: Boolean(Number(u.is_verified ?? 1)),
        verificationCode: null,
        codeExpiresAt: null,
        verificationAttempts: 0,
        resetCode: null,
        resetExpiresAt: null,
        resetAttempts: 0,
        createdAt: String(u.created_at || new Date().toISOString()),
      };
    }
  } catch {
    // `users` table optional
  }
  return null;
}

export async function upsertAccount(
  account: Omit<StoredPortalAccount, 'id'> & { id?: number },
): Promise<StoredPortalAccount> {
  const normalizedEmail = account.email.trim().toLowerCase();

  await requireD1();
  const existing = await queryD1(
    `SELECT id FROM portal_accounts WHERE email = ? LIMIT 1`,
    [normalizedEmail],
  );
  if (existing && existing.length > 0) {
    await queryD1(
      `UPDATE portal_accounts
       SET name = ?, password_hash = ?, is_verified = ?, verification_code = ?,
           code_expires_at = ?, verification_attempts = ?, reset_code = ?,
           reset_expires_at = ?, reset_attempts = ?
       WHERE email = ?`,
      [
        account.name,
        account.passwordHash,
        account.isVerified ? 1 : 0,
        account.verificationCode,
        account.codeExpiresAt,
        account.verificationAttempts,
        account.resetCode,
        account.resetExpiresAt,
        account.resetAttempts,
        normalizedEmail,
      ],
    );
  } else {
    await queryD1(
      `INSERT INTO portal_accounts
       (email, username, name, password_hash, is_verified, verification_code,
        code_expires_at, verification_attempts, reset_code, reset_expires_at,
        reset_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedEmail,
        account.username,
        account.name,
        account.passwordHash,
        account.isVerified ? 1 : 0,
        account.verificationCode,
        account.codeExpiresAt,
        account.verificationAttempts,
        account.resetCode,
        account.resetExpiresAt,
        account.resetAttempts,
        account.createdAt,
      ],
    );
  }
  const saved = await findAccountByEmailOrUsername(normalizedEmail);
  if (saved) return saved;
  throw new Error('The account could not be saved.');
}

// ============================================================================
// Member Allow / Disallow Controls
// ============================================================================
