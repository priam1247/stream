import crypto from 'node:crypto';
import { PANEL_BASE_URL, DEFAULT_PANEL_SERVER_ID } from './panel-config';
import {
  ActivityEvent,
  ApprovedUser,
  BotCommandRecord,
  BotConnectionConfig,
  BotHeartbeatRecord,
  ConfirmedMemberLink,
  MemberRecord,
  PanelConnectionConfig,
} from './types';

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

export interface SupportMessage { id: number; memberEmail: string; role: 'member' | 'admin'; text: string; createdAt: number }
export interface SupportThread { email: string; latestAt: number; preview: string; unread: number }

declare global {
  // eslint-disable-next-line no-var
  var __zafarD1SchemaV6Ready: boolean | undefined;
  // eslint-disable-next-line no-var
  var __zafarD1SchemaV6Promise: Promise<boolean> | undefined;
}

function getD1Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';
  const databaseId = process.env.D1_DATABASE_ID?.trim() || '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || '';
  if (!accountId || !databaseId || !apiToken) return null;
  return { accountId, databaseId, apiToken };
}

async function queryD1<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = [],
): Promise<T[] | null> {
  const cfg = getD1Config();
  if (!cfg) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  const body = await res.json();
  if (!res.ok || !body?.success) {
    throw new Error(
      body?.errors?.[0]?.message || `Cloudflare D1 error (${res.status})`,
    );
  }
  return (body.result?.[0]?.results as T[]) || [];
}

const D1_REQUIRED =
  'Cloudflare D1 is required: set CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN.';

/** D1 is the only store. Fail loudly rather than pretending state was saved. */
export async function requireD1(): Promise<void> {
  if (!(await ensureD1Tables())) throw new Error(D1_REQUIRED);
}

async function ensureD1Tables(): Promise<boolean> {
  const cfg = getD1Config();
  if (!cfg) return false;
  if (globalThis.__zafarD1SchemaV6Ready) return true;
  if (globalThis.__zafarD1SchemaV6Promise) return globalThis.__zafarD1SchemaV6Promise;
  const pending = initializeD1Tables();
  globalThis.__zafarD1SchemaV6Promise = pending;
  try {
    return await pending;
  } finally {
    if (globalThis.__zafarD1SchemaV6Promise === pending) globalThis.__zafarD1SchemaV6Promise = undefined;
  }
}

async function initializeD1Tables(): Promise<boolean> {
  const r1 = await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      code_expires_at TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      reset_code TEXT,
      reset_expires_at TEXT,
      reset_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  if (r1 === null) return false;

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_whatsapp_access (
      number TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      added_by TEXT,
      added_at TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      claim_id TEXT
    )
  `);
  // Existing numbers keep access; newly submitted member numbers are pending.
  // Multiple serverless cold starts can race this migration, so recheck after
  // a duplicate-column error rather than replacing or resetting any data.
  const columns = await queryD1<{ name: string }>(`PRAGMA table_info(portal_whatsapp_access)`);
  if (columns === null) return false;
  if (!columns.some((column) => column.name === 'approval_status')) {
    try {
      await queryD1(`ALTER TABLE portal_whatsapp_access ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'`);
    } catch (error) {
      const current = await queryD1<{ name: string }>(`PRAGMA table_info(portal_whatsapp_access)`);
      if (!current?.some((column) => column.name === 'approval_status')) throw error;
    }
  }

  if (!columns.some((column) => column.name === 'claim_id')) {
    try { await queryD1(`ALTER TABLE portal_whatsapp_access ADD COLUMN claim_id TEXT`); }
    catch (error) {
      const current = await queryD1<{ name: string }>(`PRAGMA table_info(portal_whatsapp_access)`);
      if (!current?.some((column) => column.name === 'claim_id')) throw error;
    }
  }
  // One-time backfill only for legacy rows without a claim. Existing claim IDs
  // are never derived from addedAt or rewritten by a sync.
  await queryD1(`UPDATE portal_whatsapp_access SET claim_id = lower(hex(randomblob(16))) WHERE claim_id IS NULL OR trim(claim_id) = ''`);
  await queryD1(`UPDATE portal_whatsapp_access SET added_at = ? WHERE added_at IS NULL OR trim(added_at) = ''`, [new Date().toISOString()]);
  await queryD1(`DELETE FROM portal_whatsapp_access WHERE label = 'Added via WhatsApp .allow'`);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_member_permissions (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      allowed INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_activity (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  await queryD1(`CREATE INDEX IF NOT EXISTS portal_activity_created_at ON portal_activity(created_at DESC)`);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_bot_commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT,
      error_text TEXT,
      requested_by TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_pair_cooldowns (
      number TEXT PRIMARY KEY,
      retry_at INTEGER NOT NULL
    )
  `);

  await queryD1(`CREATE TABLE IF NOT EXISTS portal_support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member_email TEXT NOT NULL,
    sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  await queryD1(`CREATE INDEX IF NOT EXISTS portal_support_member_id ON portal_support_messages(member_email, id)`);
  await queryD1(`CREATE TABLE IF NOT EXISTS portal_support_reads (
    member_email TEXT PRIMARY KEY, admin_seen_id INTEGER NOT NULL DEFAULT 0, member_seen_id INTEGER NOT NULL DEFAULT 0
  )`);

  await queryD1(`CREATE TABLE IF NOT EXISTS portal_session_backups (
    slot TEXT PRIMARY KEY, generation TEXT NOT NULL, claim_token TEXT NOT NULL, revision INTEGER NOT NULL,
    ciphertext TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`);

  globalThis.__zafarD1SchemaV6Ready = true;
  return true;
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

export async function isUsingCloudflareD1(): Promise<boolean> {
  return ensureD1Tables();
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

function numberApproval(value: unknown): ApprovedUser['approval'] {
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
export async function releasePairCooldown(number: string, retryAt: number): Promise<void> {
  await requireD1();
  await queryD1(`DELETE FROM portal_pair_cooldowns WHERE number = ? AND retry_at = ?`, [number, retryAt]);
  return;
}

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

async function getSettingValue(key: string): Promise<string | null> {
  await requireD1();
  const rows = (await queryD1(
    `SELECT value FROM portal_settings WHERE key = ? LIMIT 1`,
    [key],
  )) || [];
  return rows.length > 0 && rows[0].value != null ? String(rows[0].value) : null;
}

async function setSettingValue(key: string, value: string): Promise<void> {
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

function supportMessage(row: Record<string, unknown>): SupportMessage {
  return { id: Number(row.id), memberEmail: String(row.member_email), role: row.sender_role === 'admin' ? 'admin' : 'member', text: String(row.body), createdAt: Number(row.created_at) };
}

/** Atomic per-conversation throttling prevents a fast client bypassing the UI. */
export async function addSupportMessage(email: string, role: 'member' | 'admin', text: string, now = Date.now()): Promise<SupportMessage | null> {
  const owner = email.trim().toLowerCase();
  if (!owner || !text || text.length > 2000) throw new Error('Invalid message.');
  await requireD1();
  const rows = await queryD1(`INSERT INTO portal_support_messages (member_email, sender_role, body, created_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM portal_support_messages
      WHERE member_email = ? AND sender_role = ? AND created_at > ?) RETURNING *`,
    [owner, role, text, now, owner, role, now - 5000]);
  return rows?.length ? supportMessage(rows[0]) : null;
}

export async function listSupportMessages(email: string, viewer: 'member' | 'admin', markRead = true): Promise<SupportMessage[]> {
  const owner = email.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(`SELECT * FROM portal_support_messages WHERE member_email = ? ORDER BY id DESC LIMIT 200`, [owner]);
  const messages = (rows || []).map(supportMessage).reverse();
  const lastId = messages[messages.length - 1]?.id || 0;
  if (markRead && lastId) {
    const column = viewer === 'admin' ? 'admin_seen_id' : 'member_seen_id';
    await queryD1(`INSERT INTO portal_support_reads (member_email, ${column}) VALUES (?, ?)
      ON CONFLICT(member_email) DO UPDATE SET ${column} = MAX(${column}, excluded.${column})`, [owner, lastId]);
  }
  return messages;
}

export async function listSupportThreads(): Promise<SupportThread[]> {
  await requireD1();
  const rows = await queryD1(`SELECT m.member_email,
    MAX(m.created_at) AS latest_at,
    (SELECT body FROM portal_support_messages x WHERE x.member_email = m.member_email ORDER BY x.id DESC LIMIT 1) AS preview,
    SUM(CASE WHEN m.sender_role = 'member' AND m.id > COALESCE(r.admin_seen_id, 0) THEN 1 ELSE 0 END) AS unread
    FROM portal_support_messages m LEFT JOIN portal_support_reads r ON r.member_email = m.member_email
    GROUP BY m.member_email ORDER BY latest_at DESC LIMIT 200`);
  return (rows || []).map((row) => ({ email: String(row.member_email), latestAt: Number(row.latest_at), preview: String(row.preview), unread: Number(row.unread) }));
}

export async function countMemberSupportUnread(email: string): Promise<number> {
  const owner = email.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(`SELECT COUNT(*) AS total FROM portal_support_messages m LEFT JOIN portal_support_reads r ON r.member_email = m.member_email
    WHERE m.member_email = ? AND m.sender_role = 'admin' AND m.id > COALESCE(r.member_seen_id, 0)`, [owner]);
  return Number(rows?.[0]?.total) || 0;
}

export interface SessionBackupRecord { slot: string; generation: string; claimToken: string; revision: number; ciphertext: string; revoked: boolean; updatedAt: number }
function mapSessionBackup(row: Record<string, unknown>): SessionBackupRecord {
  return { slot: String(row.slot), generation: String(row.generation), claimToken: String(row.claim_token || ''), revision: Number(row.revision), ciphertext: String(row.ciphertext || ''), revoked: Boolean(Number(row.revoked)), updatedAt: Number(row.updated_at) };
}
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
export interface SessionBackupClaim { key: string; owner: string }
export function sessionBackupClaim(user: Pick<ApprovedUser, 'claimId' | 'addedAt' | 'addedBy'>): { token: string; identity: SessionBackupClaim } {
  const identity = { key: String(user.claimId || ''), owner: String(user.addedBy || '').toLowerCase() };
  return { token: crypto.createHash('sha256').update(JSON.stringify([identity.key, identity.owner])).digest('hex'), identity };
}
function claimFromRow(row: Record<string, unknown>): string {
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
export async function getEligibleSessionBackup(slot: string, claimToken: string, identity?: SessionBackupClaim | null): Promise<SessionBackupRecord | null> {
  await requireSessionBackupStorage();
  const check = backupEligibility(slot, identity);
  const rows = requireBackupRows(await queryD1(`SELECT * FROM portal_session_backups WHERE slot = ? AND claim_token = ? AND revoked = 0 AND ${check.sql} LIMIT 1`,
    [slot, claimToken, ...check.params]));
  return rows.length ? mapSessionBackup(rows[0]) : null;
}
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
async function revokeBackupForClaim(slot: string, claimToken: string): Promise<void> {
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
const MEMBER_LINK_PREFIX = 'member_confirmed_link:';
function memberLinkKey(number: string, claimToken: string): string {
  return `${MEMBER_LINK_PREFIX}${number}:${claimToken}`;
}

export async function listConfirmedMemberLinks(users: ApprovedUser[]): Promise<ConfirmedMemberLink[]> {
  const claims = new Map(users.slice(0, 101).map((user) => [memberLinkKey(user.number, sessionBackupClaim(user).token), user]));
  if (!claims.size) return [];
  const values: { key: string; value: string }[] = [];
  await requireD1();
  const keys = [...claims.keys()];
  for (let i = 0; i < keys.length; i += 80) {
    const batch = keys.slice(i, i + 80);
    const rows = await queryD1(`SELECT key, value FROM portal_settings WHERE key IN (${batch.map(() => '?').join(', ')})`, batch);
    values.push(...(rows || []).map((row) => ({ key: String(row.key), value: String(row.value) })));
  }
  const now = Date.now();
  return values.flatMap(({ key, value }) => {
    try {
      const link = JSON.parse(value) as ConfirmedMemberLink;
      const user = claims.get(key);
      if (!user || link.number !== user.number || link.claimToken !== sessionBackupClaim(user).token ||
          key !== memberLinkKey(link.number, link.claimToken) || !/^[a-f0-9]{24}$/.test(link.sessionId) ||
          !Number.isSafeInteger(link.observedAt) || link.observedAt <= 0 || link.observedAt > now + 60_000) return [];
      const linkedAt = Number.isSafeInteger(link.linkedAt) && link.linkedAt! > 0 && link.linkedAt! <= now + 60_000 ? link.linkedAt : undefined;
      return [{ number: link.number, sessionId: link.sessionId, claimToken: link.claimToken, observedAt: link.observedAt, ...(linkedAt ? { linkedAt } : {}) }];
    } catch { return []; }
  });
}

/** Save only completed links while the same owner still holds the claim. */
export async function saveConfirmedMemberLinks(links: ConfirmedMemberLink[], users: ApprovedUser[]): Promise<void> {
  const byNumber = new Map(users.map((user) => [user.number, user]));
  const unique = new Map<string, { link: ConfirmedMemberLink; user: ApprovedUser }>();
  const now = Date.now();
  for (const link of links.slice(0, 101)) {
    const user = byNumber.get(link.number);
    if (!user || sessionBackupClaim(user).token !== link.claimToken || !/^[a-f0-9]{24}$/.test(link.sessionId) ||
        !Number.isSafeInteger(link.observedAt) || link.observedAt <= 0 || link.observedAt > now + 60_000) continue;
    const linkedAt = Number.isSafeInteger(link.linkedAt) && link.linkedAt! > 0 && link.linkedAt! <= now + 60_000 ? link.linkedAt : undefined;
    const clean = { number: link.number, sessionId: link.sessionId, claimToken: link.claimToken, observedAt: link.observedAt, ...(linkedAt ? { linkedAt } : {}) };
    const key = memberLinkKey(link.number, link.claimToken);
    if (!unique.has(key) || unique.get(key)!.link.observedAt <= clean.observedAt) unique.set(key, { link: clean, user });
  }
  const entries = [...unique.entries()];
  if (!entries.length) return;
  await requireD1();
  // Each row's claim is checked at the SQL snapshot. A delayed observation
  // cannot recreate evidence after a number is unlinked or transferred.
  for (let i = 0; i < entries.length; i += 16) {
    const batch = entries.slice(i, i + 16);
    const select = batch.map(() => `SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM portal_whatsapp_access
      WHERE number = ? AND COALESCE(claim_id, '') = ? AND lower(COALESCE(added_by, '')) = ?)`).join(' UNION ALL ');
    const params = batch.flatMap(([key, { link, user }]) => {
      const identity = sessionBackupClaim(user).identity;
      return [key, JSON.stringify(link), new Date(link.observedAt).toISOString(), user.number, identity.key, identity.owner];
    });
    await queryD1(`INSERT INTO portal_settings (key, value, updated_at) ${select}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= portal_settings.updated_at`, params);
  }
  return;
}

async function deleteConfirmedMemberLink(number: string, claimToken: string): Promise<void> {
  await requireD1();
  await queryD1(`DELETE FROM portal_settings WHERE key = ?`, [memberLinkKey(number, claimToken)]);
}

export async function saveBotHeartbeat(hb: BotHeartbeatRecord): Promise<void> {
  await setSettingValue('botkeep_heartbeat_json', JSON.stringify(hb));
}

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

function mapD1BotCommand(row: Record<string, unknown>): BotCommandRecord {
  let payload: Record<string, unknown> = {};
  let result: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(String(row.payload_json || '{}'));
  } catch {
    payload = {};
  }
  if (row.result_json) {
    try {
      result = JSON.parse(String(row.result_json));
    } catch {
      result = null;
    }
  }
  return {
    id: String(row.id),
    type: String(row.type) as BotCommandRecord['type'],
    payload,
    status: String(row.status || 'pending') as BotCommandRecord['status'],
    result,
    error: row.error_text ? String(row.error_text) : null,
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
  };
}

export async function enqueueBotCommand(params: {
  type: Extract<BotCommandRecord['type'], 'pair' | 'unlink'>;
  payload: Record<string, unknown>;
  requestedBy?: string;
  ttlMs?: number;
}): Promise<BotCommandRecord> {
  const now = Date.now();
  const cmd: BotCommandRecord = {
    id: `cmd_${now.toString(36)}_${crypto.randomBytes(6).toString('hex')}`,
    type: params.type,
    payload: params.payload,
    status: 'pending',
    result: null,
    error: null,
    requestedBy: params.requestedBy,
    createdAt: now,
    expiresAt: now + (params.ttlMs || 60_000),
  };

  await requireD1();
  await queryD1(
    `DELETE FROM portal_bot_commands WHERE expires_at < ?`,
    [now - 300_000],
  );
  await queryD1(
    `INSERT INTO portal_bot_commands
     (id, type, payload_json, status, result_json, error_text, requested_by, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
    [
      cmd.id,
      cmd.type,
      JSON.stringify(cmd.payload),
      cmd.requestedBy || null,
      cmd.createdAt,
      cmd.expiresAt,
    ],
  );

  await setFastPollWindow(60_000);
  return cmd;
}

/** Recover an accepted request after a refresh without exposing another member's code. */
export async function getLatestPairCommand(number: string, requestedBy: string, since: number): Promise<BotCommandRecord | null> {
  const owner = requestedBy.toLowerCase();
  await requireD1();
  const rows = await queryD1(
    `SELECT * FROM portal_bot_commands WHERE type = 'pair' AND lower(requested_by) = ?
     AND json_extract(payload_json, '$.number') = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`, [owner, number, since],
  );
  return rows?.length ? mapD1BotCommand(rows[0]) : null;
}

/** Direct responses also get a short-lived recovery record, never a queue entry. */
export async function saveCompletedPairResult(params: {
  number: string; requestedBy: string; createdAt: number; code: string; issuedAt: number; expiresInSeconds: number;
}): Promise<void> {
  const result = JSON.stringify({ code: params.code, issuedAt: params.issuedAt,
    expiresInSeconds: params.expiresInSeconds, _dashboardReceivedAt: Date.now() });
  const id = `pair_${params.createdAt.toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const expiresAt = params.createdAt + 90_000;
  await requireD1();
  await queryD1(`DELETE FROM portal_bot_commands WHERE expires_at < ?`, [Date.now() - 300_000]);
  await queryD1(
    `INSERT INTO portal_bot_commands (id, type, payload_json, status, result_json, error_text, requested_by, created_at, expires_at)
     VALUES (?, 'pair', ?, 'completed', ?, NULL, ?, ?, ?)`,
    [id, JSON.stringify({ number: params.number }), result, params.requestedBy.toLowerCase(), params.createdAt, expiresAt],
  );
  return;
}

export async function claimPendingBotCommands(): Promise<BotCommandRecord[]> {
  const now = Date.now();

  await requireD1();
  // Claim once under overlapping polls. Never dispatch old queued power
  // requests to a service that may still have a previous hosting target.
  const rows = await queryD1(`UPDATE portal_bot_commands SET status = 'claimed'
    WHERE id IN (SELECT id FROM portal_bot_commands WHERE status = 'pending' AND expires_at >= ?
      AND type IN ('pair', 'unlink') ORDER BY created_at ASC LIMIT 10) AND status = 'pending' RETURNING *`, [now]);
  return (rows || []).map(mapD1BotCommand);
}

/** Return only this request's undelivered claims to the queue if building a
 * response fails. A completed/expired command is never made pending again. */
export async function releaseClaimedBotCommands(ids: string[]): Promise<void> {
  const safe = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 100))];
  if (!safe.length) return;
  const now = Date.now();
  await requireD1();
  for (let i = 0; i < safe.length; i += 80) {
    const batch = safe.slice(i, i + 80);
    await queryD1(`UPDATE portal_bot_commands SET status = 'pending' WHERE status = 'claimed' AND expires_at >= ? AND id IN (${batch.map(() => '?').join(', ')})`, [now, ...batch]);
  }
  return;
}

export async function completeBotCommand(params: {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}): Promise<void> {
  const status: BotCommandRecord['status'] = params.ok ? 'completed' : 'failed';
  // Record receipt on the dashboard clock once. It is a fixed upper bound for
  // checking a service-provided issuance timestamp on subsequent polls.
  const result = params.result ? { ...params.result, _dashboardReceivedAt: Date.now() } : null;
  const resultJson = result ? JSON.stringify(result) : null;
  const errorText = params.error ? String(params.error).slice(0, 400) : null;

  await requireD1();
  await queryD1(
    `UPDATE portal_bot_commands
     SET status = ?, result_json = ?, error_text = ?
     WHERE id = ? AND status IN ('pending', 'claimed')`,
    [status, resultJson, errorText, params.id],
  );
  return;
}

export async function getBotCommandById(
  id: string,
): Promise<BotCommandRecord | null> {
  await requireD1();
  const rows = await queryD1(
    `SELECT * FROM portal_bot_commands WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows || rows.length === 0) return null;
  return mapD1BotCommand(rows[0]);
}

// ---------------------------------------------------------------------------
// Owner activity history. Never put credentials, pairing codes or PDF contents
// in these records. D1 is durable; the disk fallback is for local/self-hosting.
// ---------------------------------------------------------------------------

export async function appendActivity(event: Omit<ActivityEvent, 'id' | 'createdAt'>): Promise<void> {
  const now = new Date().toISOString();
  const entry: ActivityEvent = {
    id: crypto.randomUUID(),
    category: event.category,
    action: event.action.slice(0, 100),
    actor: event.actor.trim().toLowerCase().slice(0, 160),
    outcome: event.outcome,
    detail: event.detail.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 200),
    createdAt: now,
  };
  await requireD1();
  await queryD1(
    `INSERT INTO portal_activity (id, category, action, actor, outcome, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.category, entry.action, entry.actor, entry.outcome, entry.detail, entry.createdAt],
  );
  // Bound retention so the history does not grow indefinitely.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await queryD1(`DELETE FROM portal_activity WHERE created_at < ?`, [cutoff]);
  return;
}

export async function listRecentActivity(limit = 100): Promise<ActivityEvent[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 100));
  await requireD1();
  const rows = (await queryD1(
    `SELECT id, category, action, actor, outcome, detail, created_at
     FROM portal_activity ORDER BY created_at DESC, id DESC LIMIT ?`,
    [safeLimit],
  )) || [];
  return rows.map((row) => ({
    id: String(row.id),
    category: String(row.category) as ActivityEvent['category'],
    action: String(row.action),
    actor: String(row.actor),
    outcome: String(row.outcome) as ActivityEvent['outcome'],
    detail: String(row.detail || ''),
    createdAt: String(row.created_at),
  }));
}
