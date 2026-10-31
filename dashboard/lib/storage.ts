import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCRIBD_WEB_URL } from './scribd-config';
import {
  ActivityEvent,
  ApprovedUser,
  BotCommandRecord,
  BotConnectionConfig,
  BotHeartbeatRecord,
  MemberRecord,
  PanelConnectionConfig,
  ScribdConnectionConfig,
  WhatsAppFailoverStatus,
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

interface StoredMemberPermission {
  email: string;
  name: string;
  allowed: boolean;
  updatedAt: string;
}

interface StoredMemberFeatures {
  email: string;
  scribdAllowed: boolean;
  updatedAt: string;
}

export interface SupportMessage { id: number; memberEmail: string; role: 'member' | 'admin'; text: string; createdAt: number }
export interface SupportThread { email: string; latestAt: number; preview: string; unread: number }

interface DiskStoreSchema {
  nextUserId: number;
  accounts: StoredPortalAccount[];
  whatsappUsers: ApprovedUser[];
  memberPermissions: StoredMemberPermission[];
  memberFeatures: StoredMemberFeatures[];
  activity: ActivityEvent[];
  botCommands: BotCommandRecord[];
  pairCooldowns: Record<string, number>;
  supportMessages: SupportMessage[];
  supportReads: Record<string, { admin: number; member: number }>;
  settings: Record<string, string>;
}

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'zafar-db.json');

declare global {
  // eslint-disable-next-line no-var
  var __zafarD1SchemaV6Ready: boolean | undefined;
  // eslint-disable-next-line no-var
  var __zafarD1SchemaV6Promise: Promise<boolean> | undefined;
  // eslint-disable-next-line no-var
  var __zafarD1UnreachableInDev: boolean | undefined;
  // eslint-disable-next-line no-var
  var __zafarFailoverSchemaReady: boolean | undefined;
  // eslint-disable-next-line no-var
  var __zafarFailoverSchemaPromise: Promise<boolean> | undefined;
}

function getD1Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';
  const databaseId = process.env.D1_DATABASE_ID?.trim() || '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || '';
  if (!accountId || !databaseId || !apiToken) return null;
  return { accountId, databaseId, apiToken };
}

// An unreachable shared database may already contain a lease. Never silently
// switch a coordinated dashboard to uncoordinated disk storage. Developers can
// explicitly opt into isolated single-host disk mode for offline local work.
function mayUseStandaloneDisk(): boolean {
  return !getD1Config() || (process.env.NODE_ENV !== 'production' &&
    globalThis.__zafarD1UnreachableInDev === true && process.env.ZAFAR_DEV_STANDALONE_FALLBACK === '1');
}

async function queryD1<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = [],
): Promise<T[] | null> {
  const cfg = getD1Config();
  if (!cfg || globalThis.__zafarD1UnreachableInDev) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  try {
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
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      globalThis.__zafarD1UnreachableInDev = true;
      return null;
    }
    throw err;
  }
}

async function ensureD1Tables(): Promise<boolean> {
  const cfg = getD1Config();
  if (!cfg || globalThis.__zafarD1UnreachableInDev) return false;
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

// Separate migration marker so an already-warm V6 dashboard still creates the
// new coordination tables after a code update. Concurrent cold starts coalesce.
async function ensureFailoverTables(): Promise<boolean> {
  if (!await ensureD1Tables()) return false;
  if (globalThis.__zafarFailoverSchemaReady) return true;
  if (globalThis.__zafarFailoverSchemaPromise) return globalThis.__zafarFailoverSchemaPromise;
  const pending = (async () => {
    const lease = await queryD1(`CREATE TABLE IF NOT EXISTS portal_bot_failover (
      id TEXT PRIMARY KEY, owner_role TEXT NOT NULL, owner_instance TEXT NOT NULL,
      expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL
    )`);
    const nodes = await queryD1(`CREATE TABLE IF NOT EXISTS portal_bot_failover_nodes (
      role TEXT PRIMARY KEY, instance TEXT NOT NULL, last_seen_at INTEGER NOT NULL,
      connected INTEGER, version TEXT NOT NULL DEFAULT '', account_hash TEXT NOT NULL DEFAULT '',
      device_fingerprint TEXT NOT NULL DEFAULT ''
    )`);
    if (lease === null || nodes === null) return false;
    globalThis.__zafarFailoverSchemaReady = true;
    return true;
  })();
  globalThis.__zafarFailoverSchemaPromise = pending;
  try { return await pending; }
  finally { if (globalThis.__zafarFailoverSchemaPromise === pending) globalThis.__zafarFailoverSchemaPromise = undefined; }
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

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_member_permissions (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      allowed INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_member_features (
      email TEXT PRIMARY KEY,
      scribd_allowed INTEGER NOT NULL DEFAULT 0,
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

  if (globalThis.__zafarD1UnreachableInDev) return false;
  globalThis.__zafarD1SchemaV6Ready = true;
  return true;
}

function readDiskStore(): DiskStoreSchema {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return {
        nextUserId: Number(parsed.nextUserId) || 1,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        whatsappUsers: Array.isArray(parsed.whatsappUsers) ? parsed.whatsappUsers : [],
        memberPermissions: Array.isArray(parsed.memberPermissions)
          ? parsed.memberPermissions
          : [],
        memberFeatures: Array.isArray(parsed.memberFeatures) ? parsed.memberFeatures : [],
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
        botCommands: Array.isArray(parsed.botCommands) ? parsed.botCommands : [],
        pairCooldowns: parsed.pairCooldowns && typeof parsed.pairCooldowns === 'object' ? parsed.pairCooldowns : {},
        supportMessages: Array.isArray(parsed.supportMessages) ? parsed.supportMessages : [],
        supportReads: parsed.supportReads && typeof parsed.supportReads === 'object' ? parsed.supportReads : {},
        settings:
          parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      };
    }
  } catch {
    // Never replace a corrupt or unreadable store with an empty one: that can
    // silently discard accounts, permissions and activity on the next write.
    throw new Error('Dashboard local storage could not be read. Restore it or configure Cloudflare D1.');
  }
  return {
    nextUserId: 1,
    accounts: [],
    whatsappUsers: [],
    memberPermissions: [],
    memberFeatures: [],
    activity: [],
    botCommands: [],
    pairCooldowns: {},
    supportMessages: [],
    supportReads: {},
    settings: {},
  };
}

function writeDiskStore(data: DiskStoreSchema): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    throw new Error('Dashboard storage is unavailable. Configure a writable local store or Cloudflare D1.');
  }
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

  if (await ensureD1Tables()) {
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

  const store = readDiskStore();
  return store.accounts.find((a) => a.email === key || a.username === key) || null;
}

export async function upsertAccount(
  account: Omit<StoredPortalAccount, 'id'> & { id?: number },
): Promise<StoredPortalAccount> {
  const normalizedEmail = account.email.trim().toLowerCase();

  if (await ensureD1Tables()) {
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
  }

  const store = readDiskStore();
  const idx = store.accounts.findIndex((a) => a.email === normalizedEmail);
  if (idx >= 0) {
    const updated: StoredPortalAccount = {
      ...store.accounts[idx],
      ...account,
      id: store.accounts[idx].id,
      email: normalizedEmail,
    };
    store.accounts[idx] = updated;
    writeDiskStore(store);
    return updated;
  }

  const created: StoredPortalAccount = {
    ...account,
    id: store.nextUserId++,
    email: normalizedEmail,
  };
  store.accounts.push(created);
  writeDiskStore(store);
  return created;
}

// ============================================================================
// Member Allow / Disallow Controls
// ============================================================================

export async function isMemberEmailAllowed(email: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  if (!clean) return false;

  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT allowed FROM portal_member_permissions WHERE email = ? LIMIT 1`,
      [clean],
    );
    if (rows && rows.length > 0) {
      return Boolean(Number(rows[0].allowed));
    }
    return true;
  }

  const store = readDiskStore();
  const perm = store.memberPermissions.find((p) => p.email === clean);
  return perm ? perm.allowed : true;
}

export async function setMemberPermission(
  email: string,
  allowed: boolean,
  name = '',
): Promise<void> {
  const clean = email.trim().toLowerCase();
  const now = new Date().toISOString();

  if (await ensureD1Tables()) {
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

  const store = readDiskStore();
  const existing = store.memberPermissions.find((p) => p.email === clean);
  if (existing) {
    existing.allowed = allowed;
    if (name.trim()) existing.name = name.trim();
    existing.updatedAt = now;
  } else {
    store.memberPermissions.unshift({
      email: clean,
      name: name.trim(),
      allowed,
      updatedAt: now,
    });
  }
  for (const num of store.whatsappUsers) {
    if ((num.addedBy || '').toLowerCase() === clean) {
      num.enabled = allowed && (!num.approval || num.approval === 'approved');
    }
  }
  writeDiskStore(store);
}

export async function removeMemberPermissionRecord(email: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  await setMemberPermission(clean, false);
}

/** Scribd is private by default. This grant never bypasses the member block. */
export async function isMemberScribdAllowed(email: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  if (!clean) return false;
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT scribd_allowed FROM portal_member_features WHERE email = ? LIMIT 1`,
      [clean],
    );
    return Boolean(rows?.length && Number(rows[0].scribd_allowed));
  }
  return readDiskStore().memberFeatures.find((item) => item.email === clean)?.scribdAllowed === true;
}

export async function setMemberScribdAllowed(email: string, allowed: boolean): Promise<void> {
  const clean = email.trim().toLowerCase();
  if (!clean) throw new Error('Member email required.');
  const now = new Date().toISOString();
  if (await ensureD1Tables()) {
    await queryD1(
      `INSERT INTO portal_member_features (email, scribd_allowed, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET scribd_allowed = excluded.scribd_allowed, updated_at = excluded.updated_at`,
      [clean, allowed ? 1 : 0, now],
    );
    return;
  }
  const store = readDiskStore();
  const existing = store.memberFeatures.find((item) => item.email === clean);
  if (existing) {
    existing.scribdAllowed = allowed;
    existing.updatedAt = now;
  } else {
    store.memberFeatures.push({ email: clean, scribdAllowed: allowed, updatedAt: now });
  }
  writeDiskStore(store);
}

async function memberScribdGrants(): Promise<Set<string>> {
  if (await ensureD1Tables()) {
    const rows = (await queryD1(`SELECT email FROM portal_member_features WHERE scribd_allowed = 1`)) || [];
    return new Set(rows.map((row) => String(row.email).toLowerCase()));
  }
  return new Set(readDiskStore().memberFeatures.filter((item) => item.scribdAllowed).map((item) => item.email.toLowerCase()));
}

export async function listAllMembers(
  checkAdmin: (email: string) => boolean,
): Promise<MemberRecord[]> {
  const [whatsappAll, scribdGrants] = await Promise.all([listStoredWhatsAppUsers(), memberScribdGrants()]);
  const countByEmail = new Map<string, number>();
  for (const item of whatsappAll) {
    const owner = (item.addedBy || '').toLowerCase();
    if (owner) countByEmail.set(owner, (countByEmail.get(owner) || 0) + 1);
  }

  const merged = new Map<string, MemberRecord>();

  if (await ensureD1Tables()) {
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
        scribdAllowed: checkAdmin(em) || scribdGrants.has(em),
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
          scribdAllowed: checkAdmin(em) || scribdGrants.has(em),
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
          scribdAllowed: checkAdmin(em) || scribdGrants.has(em),
          numbersCount: countByEmail.get(em) || 0,
          createdAt: perm.updatedAt,
        });
      }
    }

    return Array.from(merged.values());
  }

  const store = readDiskStore();
  const permMap = new Map(
    store.memberPermissions.map((p) => [p.email.toLowerCase(), p]),
  );
  for (const acc of store.accounts) {
    const em = acc.email.toLowerCase();
    const perm = permMap.get(em);
    merged.set(em, {
      email: em,
      name: acc.name || perm?.name || em.split('@')[0],
      isVerified: acc.isVerified,
      isAdmin: checkAdmin(em),
      allowed: checkAdmin(em) ? true : perm ? perm.allowed : true,
      scribdAllowed: checkAdmin(em) || scribdGrants.has(em),
      numbersCount: countByEmail.get(em) || 0,
      createdAt: acc.createdAt,
    });
  }
  for (const perm of store.memberPermissions) {
    const em = perm.email.toLowerCase();
    if (!merged.has(em)) {
      merged.set(em, {
        email: em,
        name: perm.name || em.split('@')[0],
        isVerified: false,
        isAdmin: checkAdmin(em),
        allowed: checkAdmin(em) ? true : perm.allowed,
        scribdAllowed: checkAdmin(em) || scribdGrants.has(em),
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
  const envUrl = process.env.BOT_API_URL?.trim() || '';
  const envToken = process.env.ADMIN_DASHBOARD_TOKEN?.trim() || '';
  const envSyncToken = process.env.BOT_SYNC_TOKEN?.trim() || '';
  const envXsToken = process.env.BOT_XS_SYNC_TOKEN?.trim() || '';
  const envBotkeepToken = process.env.BOT_BOTKEEP_SYNC_TOKEN?.trim() || '';

  if (await ensureD1Tables()) {
    const rows =
      (await queryD1(`SELECT key, value, updated_at FROM portal_settings`)) || [];
    const map = new Map<string, string>();
    let updatedAt: string | undefined;
    for (const r of rows) {
      map.set(String(r.key), String(r.value));
      if (r.updated_at) updatedAt = String(r.updated_at);
    }
    return {
      botApiUrl: (map.get('bot_api_url') || envUrl).trim(),
      botAdminToken: (map.get('bot_admin_token') || envToken).trim(),
      botSyncToken: (map.get('bot_sync_token') || envSyncToken).trim(),
      botXsSyncToken: (map.has('bot_xs_sync_token') ? map.get('bot_xs_sync_token')! : envXsToken).trim(),
      botBotkeepSyncToken: (map.has('bot_botkeep_sync_token') ? map.get('bot_botkeep_sync_token')! : envBotkeepToken).trim(),
      botEnabledForMembers: map.get('bot_enabled_for_members') !== '0',
      updatedAt,
    };
  }

  const store = readDiskStore();
  return {
    botApiUrl: (store.settings.bot_api_url || envUrl).trim(),
    botAdminToken: (store.settings.bot_admin_token || envToken).trim(),
    botSyncToken: (store.settings.bot_sync_token || envSyncToken).trim(),
    botXsSyncToken: (Object.hasOwn(store.settings, 'bot_xs_sync_token') ? store.settings.bot_xs_sync_token : envXsToken).trim(),
    botBotkeepSyncToken: (Object.hasOwn(store.settings, 'bot_botkeep_sync_token') ? store.settings.bot_botkeep_sync_token : envBotkeepToken).trim(),
    botEnabledForMembers: store.settings.bot_enabled_for_members !== '0',
    updatedAt: store.settings.updated_at,
  };
}

export async function saveBotConnectionConfig(patch: {
  botApiUrl?: string;
  botAdminToken?: string;
  botSyncToken?: string;
  botXsSyncToken?: string;
  botBotkeepSyncToken?: string;
  botEnabledForMembers?: boolean;
}): Promise<BotConnectionConfig> {
  const current = await getBotConnectionConfig();
  const nextUrl =
    typeof patch.botApiUrl === 'string' ? patch.botApiUrl.trim() : current.botApiUrl;
  const nextToken =
    typeof patch.botAdminToken === 'string'
      ? patch.botAdminToken.trim()
      : current.botAdminToken;
  const nextSyncToken =
    typeof patch.botSyncToken === 'string'
      ? patch.botSyncToken.trim()
      : current.botSyncToken;
  const nextXsToken = typeof patch.botXsSyncToken === 'string' ? patch.botXsSyncToken.trim() : current.botXsSyncToken;
  const nextBotkeepToken = typeof patch.botBotkeepSyncToken === 'string' ? patch.botBotkeepSyncToken.trim() : current.botBotkeepSyncToken;
  if ([patch.botAdminToken, patch.botSyncToken, patch.botXsSyncToken, patch.botBotkeepSyncToken].some((value) => typeof value === 'string')) {
    const legacy = [nextToken, nextSyncToken, process.env.ADMIN_DASHBOARD_TOKEN?.trim() || '', process.env.BOT_SYNC_TOKEN?.trim() || ''].filter(Boolean);
    if ([nextXsToken, nextBotkeepToken].some((token) => token && (token.length < 32 || token.length > 512))) {
      throw Object.assign(new Error('Each failover token must be between 32 and 512 characters.'), { code: 'INVALID_BOT_CREDENTIALS' });
    }
    if ((nextXsToken && (nextXsToken === nextBotkeepToken || legacy.includes(nextXsToken))) ||
        (nextBotkeepToken && legacy.includes(nextBotkeepToken))) {
      throw Object.assign(new Error('XS, Botkeep and single-host tokens must all be different.'), { code: 'INVALID_BOT_CREDENTIALS' });
    }
  }
  const nextEnabled =
    typeof patch.botEnabledForMembers === 'boolean'
      ? patch.botEnabledForMembers
      : current.botEnabledForMembers;
  const now = new Date().toISOString();
  // Write only fields actually supplied, so an unrelated member-switch request
  // cannot restore a stale credential. Save multiple changes atomically.
  const entries: [string, string][] = [];
  if (typeof patch.botApiUrl === 'string') entries.push(['bot_api_url', nextUrl]);
  if (typeof patch.botAdminToken === 'string') entries.push(['bot_admin_token', nextToken]);
  if (typeof patch.botSyncToken === 'string') entries.push(['bot_sync_token', nextSyncToken]);
  if (typeof patch.botXsSyncToken === 'string') entries.push(['bot_xs_sync_token', nextXsToken]);
  if (typeof patch.botBotkeepSyncToken === 'string') entries.push(['bot_botkeep_sync_token', nextBotkeepToken]);
  if (typeof patch.botEnabledForMembers === 'boolean') entries.push(['bot_enabled_for_members', nextEnabled ? '1' : '0']);
  const result = { botApiUrl: nextUrl, botAdminToken: nextToken, botSyncToken: nextSyncToken,
    botXsSyncToken: nextXsToken, botBotkeepSyncToken: nextBotkeepToken, botEnabledForMembers: nextEnabled, updatedAt: now };

  if (await ensureD1Tables()) {
    if (!entries.length) return result;
    const values = entries.flatMap(([key, value]) => [key, value, now]);
    const rows = await queryD1(`INSERT INTO portal_settings (key, value, updated_at)
      VALUES ${entries.map(() => '(?, ?, ?)').join(', ')}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, values);
    if (rows !== null) return result;
  }

  const store = readDiskStore();
  for (const [key, value] of entries) store.settings[key] = value;
  if (entries.length) { store.settings.updated_at = now; writeDiskStore(store); }
  return result;
}

// ============================================================================
// Stored WhatsApp Numbers CRUD (Scoped & Global)
// ============================================================================

function numberApproval(value: unknown): ApprovedUser['approval'] {
  if (value === 'pending' || value === 'rejected') return value;
  // Rows from before this feature had no approval field and retain access.
  return value == null || value === 'approved' ? 'approved' : 'rejected';
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

function localNumber(store: DiskStoreSchema, user: ApprovedUser): ApprovedUser {
  const approval = numberApproval(user.approval);
  const owner = (user.addedBy || '').toLowerCase();
  const permission = store.memberPermissions.find((item) => item.email.toLowerCase() === owner);
  return { ...user, approval, enabled: approval === 'approved' && user.enabled && permission?.allowed !== false,
    pairAllowed: approval === 'pending' && permission?.allowed !== false };
}

const SELECT_WHATSAPP_USERS = `SELECT u.number, u.label, u.enabled, u.added_by, u.added_at, u.approval_status, u.claim_id,
  COALESCE(p.allowed, 1) AS owner_allowed FROM portal_whatsapp_access u
  LEFT JOIN portal_member_permissions p ON lower(p.email) = lower(u.added_by)`;

export async function listStoredWhatsAppUsers(ownerEmail?: string): Promise<ApprovedUser[]> {
  const filterOwner = ownerEmail?.trim().toLowerCase();
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `${SELECT_WHATSAPP_USERS} ${filterOwner ? 'WHERE lower(u.added_by) = ?' : ''} ORDER BY u.added_at DESC`,
      filterOwner ? [filterOwner] : [],
    );
    if (rows) return rows.map(mapNumberRow);
  }
  const store = readDiskStore();
  return store.whatsappUsers.filter((user) => !filterOwner || (user.addedBy || '').toLowerCase() === filterOwner)
    .map((user) => localNumber(store, user));
}

export async function getStoredWhatsAppUser(number: string): Promise<ApprovedUser | null> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(`${SELECT_WHATSAPP_USERS} WHERE u.number = ? LIMIT 1`, [number]);
    return rows?.length ? mapNumberRow(rows[0]) : null;
  }
  const store = readDiskStore();
  const user = store.whatsappUsers.find((item) => item.number === number);
  return user ? localNumber(store, user) : null;
}

/** Owner-added numbers are explicitly approved. */
export async function saveStoredWhatsAppUser(number: string, label: string, addedBy: string): Promise<ApprovedUser[]> {
  const now = new Date().toISOString();
  const cleanOwner = addedBy.trim().toLowerCase();
  if (await ensureD1Tables()) {
    await queryD1(
      `INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at, approval_status, claim_id)
       VALUES (?, ?, 1, ?, ?, 'approved', ?)
       ON CONFLICT(number) DO UPDATE SET enabled = 1, label = excluded.label,
         claim_id = CASE WHEN lower(portal_whatsapp_access.added_by) = excluded.added_by THEN portal_whatsapp_access.claim_id ELSE excluded.claim_id END,
         added_by = excluded.added_by, approval_status = 'approved'`,
      [number, label, cleanOwner, now, crypto.randomUUID()],
    );
    return listStoredWhatsAppUsers();
  }
  const store = readDiskStore();
  const existing = store.whatsappUsers.find((u) => u.number === number);
  if (existing) { if ((existing.addedBy || '').toLowerCase() !== cleanOwner) existing.claimId = crypto.randomUUID(); Object.assign(existing, { enabled: true, label, addedBy: cleanOwner, approval: 'approved' }); }
  else store.whatsappUsers.unshift({ number, label, enabled: true, addedBy: cleanOwner, addedAt: now, approval: 'approved', claimId: crypto.randomUUID() });
  writeDiskStore(store);
  return store.whatsappUsers.map((user) => localNumber(store, user));
}

/** Claim a new number as pending; a member cannot re-enable or transfer it. */
export async function saveMemberWhatsAppUser(number: string, label: string, addedBy: string): Promise<boolean> {
  const owner = addedBy.trim().toLowerCase();
  const now = new Date().toISOString();
  if (await ensureD1Tables()) {
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
  const store = readDiskStore();
  const current = store.whatsappUsers.find((user) => user.number === number);
  if (current && (current.addedBy || '').toLowerCase() !== owner) return false;
  if (store.whatsappUsers.some((user) => user.number !== number && (user.addedBy || '').toLowerCase() === owner && user.approval === 'pending')) return false;
  if (current) current.label = label;
  else store.whatsappUsers.unshift({ number, label, enabled: false, approval: 'pending', addedBy: owner, addedAt: now, claimId: crypto.randomUUID() });
  writeDiskStore(store);
  return true;
}

export async function updateStoredWhatsAppUser(
  number: string,
  patch: { enabled?: boolean; label?: string; approval?: ApprovedUser['approval'] },
): Promise<ApprovedUser | null> {
  if (await ensureD1Tables()) {
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
  const store = readDiskStore();
  const target = store.whatsappUsers.find((user) => user.number === number);
  if (!target) return null;
  if (patch.approval) target.approval = patch.approval;
  if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled;
  if (target.approval && target.approval !== 'approved') target.enabled = false;
  if (typeof patch.label === 'string' && patch.label.trim()) target.label = patch.label.trim().slice(0, 80);
  writeDiskStore(store);
  return localNumber(store, target);
}

/** Resolve only the same pending claim, even if it was removed concurrently. */
export async function resolvePendingWhatsAppUser(number: string, owner: string, approve: boolean, expectedClaim?: string): Promise<ApprovedUser | null> {
  const email = owner.trim().toLowerCase();
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `UPDATE portal_whatsapp_access SET approval_status = ?, enabled = ?
       WHERE number = ? AND lower(added_by) = ? AND approval_status = 'pending'
         AND (? IS NULL OR COALESCE(NULLIF(claim_id, ''), added_at, '') = ?)
         AND (? = 0 OR COALESCE((SELECT allowed FROM portal_member_permissions WHERE lower(email) = ?), 1) = 1)
       RETURNING number`,
      [approve ? 'approved' : 'rejected', approve ? 1 : 0, number, email, expectedClaim ?? null, expectedClaim ?? null, approve ? 1 : 0, email],
    );
    return rows?.length ? getStoredWhatsAppUser(number) : null;
  }
  const store = readDiskStore();
  const target = store.whatsappUsers.find((user) => user.number === number && (user.addedBy || '').toLowerCase() === email && user.approval === 'pending');
  if (!target || (expectedClaim !== undefined && String(target.claimId || target.addedAt || '') !== expectedClaim) ||
      (approve && store.memberPermissions.some((permission) => permission.email === email && !permission.allowed))) return null;
  target.approval = approve ? 'approved' : 'rejected';
  target.enabled = approve;
  writeDiskStore(store);
  return localNumber(store, target);
}

export async function deleteStoredWhatsAppUser(
  number: string,
): Promise<ApprovedUser[]> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(`DELETE FROM portal_whatsapp_access WHERE number = ? RETURNING claim_id, added_at, added_by`, [number]);
    if (rows?.length) await revokeBackupForClaim(`linked:${number}`, claimFromRow(rows[0]));
    return listStoredWhatsAppUsers();
  }

  const store = readDiskStore();
  store.whatsappUsers = store.whatsappUsers.filter((u) => u.number !== number);
  writeDiskStore(store);
  return store.whatsappUsers;
}

/** Three-minute resend protection, keyed by phone and atomic across D1 workers. */
export async function claimPairCooldown(number: string, now = Date.now()): Promise<{ ok: boolean; retryAt: number }> {
  const retryAt = now + 180_000;
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `INSERT INTO portal_pair_cooldowns (number, retry_at) VALUES (?, ?)
       ON CONFLICT(number) DO UPDATE SET retry_at = excluded.retry_at
       WHERE portal_pair_cooldowns.retry_at <= ? RETURNING retry_at`,
      [number, retryAt, now],
    );
    if (rows?.length) return { ok: true, retryAt };
    return { ok: false, retryAt: await getPairCooldown(number) };
  }
  const store = readDiskStore();
  const previous = Number(store.pairCooldowns[number]) || 0;
  if (previous > now) return { ok: false, retryAt: previous };
  store.pairCooldowns[number] = retryAt;
  // Keep the local development store bounded; a new accepted attempt replaces
  // expired entries without touching a still-active cooldown.
  for (const [key, value] of Object.entries(store.pairCooldowns)) {
    if (Number(value) <= now) delete store.pairCooldowns[key];
  }
  writeDiskStore(store);
  return { ok: true, retryAt };
}

export async function getPairCooldown(number: string): Promise<number> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(`SELECT retry_at FROM portal_pair_cooldowns WHERE number = ?`, [number]);
    return Number(rows?.[0]?.retry_at) || 0;
  }
  return Number(readDiskStore().pairCooldowns[number]) || 0;
}

/** Release only our own attempt when no pairing request was accepted. */
export async function releasePairCooldown(number: string, retryAt: number): Promise<void> {
  if (await ensureD1Tables()) {
    await queryD1(`DELETE FROM portal_pair_cooldowns WHERE number = ? AND retry_at = ?`, [number, retryAt]);
    return;
  }
  const store = readDiskStore();
  if (Number(store.pairCooldowns[number]) === retryAt) {
    delete store.pairCooldowns[number];
    writeDiskStore(store);
  }
}

/** Remove only a number still owned by the caller, even after a queued unlink. */
export async function deleteWhatsAppUserIfOwned(number: string, ownerEmail: string, expectedClaim?: string): Promise<boolean> {
  const owner = ownerEmail.trim().toLowerCase();
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `DELETE FROM portal_whatsapp_access WHERE number = ? AND lower(added_by) = ?
       AND (? IS NULL OR COALESCE(NULLIF(claim_id, ''), added_at, '') = ?) RETURNING claim_id, added_at, added_by`,
      [number, owner, expectedClaim ?? null, expectedClaim ?? null],
    );
    if (rows?.length) await revokeBackupForClaim(`linked:${number}`, claimFromRow(rows[0]));
    return Boolean(rows?.length);
  }
  const store = readDiskStore();
  const before = store.whatsappUsers.length;
  store.whatsappUsers = store.whatsappUsers.filter((user) =>
    !(user.number === number && (user.addedBy || '').toLowerCase() === owner &&
      (expectedClaim === undefined || String(user.claimId || user.addedAt || '') === expectedClaim)));
  if (store.whatsappUsers.length === before) return false;
  writeDiskStore(store);
  return true;
}

// ============================================================================
// Bot Heartbeat, Versioned Whitelist, Command Queue & Panel Config
// ============================================================================

const DEFAULT_PANEL_URL = 'https://panel.xsystemshosting.com';
const DEFAULT_XS_SERVER_ID = '381c9516';

async function getSettingValue(key: string): Promise<string | null> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT value FROM portal_settings WHERE key = ? LIMIT 1`,
      [key],
    );
    if (rows && rows.length > 0 && rows[0].value != null) {
      return String(rows[0].value);
    }
    return null;
  }
  const store = readDiskStore();
  return store.settings[key] ?? null;
}

async function setSettingValue(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  if (await ensureD1Tables()) {
    await queryD1(
      `INSERT INTO portal_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now],
    );
    return;
  }
  const store = readDiskStore();
  store.settings[key] = value;
  writeDiskStore(store);
}

const COMMAND_SETTING_PREFIX = 'member_command_disabled:';

/** Each command is stored separately so concurrent switches cannot overwrite each other. */
export async function getMemberCommandPolicy(): Promise<{ disabled: string[]; version: string }> {
  let disabled: string[];
  if (await ensureD1Tables()) {
    const rows = await queryD1(`SELECT key FROM portal_settings WHERE substr(key, 1, ?) = ? AND value = '1'`, [COMMAND_SETTING_PREFIX.length, COMMAND_SETTING_PREFIX]);
    disabled = (rows || []).map((row) => String(row.key).slice(COMMAND_SETTING_PREFIX.length));
  } else {
    disabled = Object.entries(readDiskStore().settings).filter(([key, value]) => key.startsWith(COMMAND_SETTING_PREFIX) && value === '1')
      .map(([key]) => key.slice(COMMAND_SETTING_PREFIX.length));
  }
  disabled = [...new Set(disabled.filter((name) => /^[a-z0-9_]{1,40}$/.test(name)))].sort();
  return { disabled, version: crypto.createHash('sha256').update(JSON.stringify(disabled)).digest('hex').slice(0, 16) };
}

export async function setMemberCommandDisabled(name: string, disabled: boolean): Promise<void> {
  if (!/^[a-z0-9_]{1,40}$/.test(name)) throw new Error('Invalid command.');
  await setSettingValue(`${COMMAND_SETTING_PREFIX}${name}`, disabled ? '1' : '0');
  await setFastPollWindow(30_000);
}

function supportMessage(row: Record<string, unknown>): SupportMessage {
  return { id: Number(row.id), memberEmail: String(row.member_email), role: row.sender_role === 'admin' ? 'admin' : 'member', text: String(row.body), createdAt: Number(row.created_at) };
}

/** Atomic per-conversation throttling prevents a fast client bypassing the UI. */
export async function addSupportMessage(email: string, role: 'member' | 'admin', text: string, now = Date.now()): Promise<SupportMessage | null> {
  const owner = email.trim().toLowerCase();
  if (!owner || !text || text.length > 2000) throw new Error('Invalid message.');
  if (await ensureD1Tables()) {
    const rows = await queryD1(`INSERT INTO portal_support_messages (member_email, sender_role, body, created_at)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM portal_support_messages
        WHERE member_email = ? AND sender_role = ? AND created_at > ?) RETURNING *`,
      [owner, role, text, now, owner, role, now - 5000]);
    return rows?.length ? supportMessage(rows[0]) : null;
  }
  const store = readDiskStore();
  if (store.supportMessages.some((item) => item.memberEmail === owner && item.role === role && item.createdAt > now - 5000)) return null;
  const id = Math.max(0, ...store.supportMessages.map((item) => item.id)) + 1;
  const message: SupportMessage = { id, memberEmail: owner, role, text, createdAt: now };
  store.supportMessages.push(message);
  writeDiskStore(store);
  return message;
}

export async function listSupportMessages(email: string, viewer: 'member' | 'admin', markRead = true): Promise<SupportMessage[]> {
  const owner = email.trim().toLowerCase();
  if (await ensureD1Tables()) {
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
  const store = readDiskStore();
  const messages = store.supportMessages.filter((item) => item.memberEmail === owner).slice(-200);
  const lastId = messages[messages.length - 1]?.id || 0;
  if (markRead && lastId) {
    const seen = store.supportReads[owner] || { admin: 0, member: 0 };
    seen[viewer] = Math.max(seen[viewer], lastId); store.supportReads[owner] = seen; writeDiskStore(store);
  }
  return messages;
}

export async function listSupportThreads(): Promise<SupportThread[]> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(`SELECT m.member_email,
      MAX(m.created_at) AS latest_at,
      (SELECT body FROM portal_support_messages x WHERE x.member_email = m.member_email ORDER BY x.id DESC LIMIT 1) AS preview,
      SUM(CASE WHEN m.sender_role = 'member' AND m.id > COALESCE(r.admin_seen_id, 0) THEN 1 ELSE 0 END) AS unread
      FROM portal_support_messages m LEFT JOIN portal_support_reads r ON r.member_email = m.member_email
      GROUP BY m.member_email ORDER BY latest_at DESC LIMIT 200`);
    return (rows || []).map((row) => ({ email: String(row.member_email), latestAt: Number(row.latest_at), preview: String(row.preview), unread: Number(row.unread) }));
  }
  const store = readDiskStore();
  const emails = [...new Set(store.supportMessages.map((item) => item.memberEmail))];
  return emails.map((email) => {
    const messages = store.supportMessages.filter((item) => item.memberEmail === email);
    const last = messages[messages.length - 1];
    return { email, latestAt: last.createdAt, preview: last.text, unread: messages.filter((item) => item.role === 'member' && item.id > (store.supportReads[email]?.admin || 0)).length };
  }).sort((a, b) => b.latestAt - a.latestAt).slice(0, 200);
}

export async function countMemberSupportUnread(email: string): Promise<number> {
  const owner = email.trim().toLowerCase();
  if (await ensureD1Tables()) {
    const rows = await queryD1(`SELECT COUNT(*) AS total FROM portal_support_messages m LEFT JOIN portal_support_reads r ON r.member_email = m.member_email
      WHERE m.member_email = ? AND m.sender_role = 'admin' AND m.id > COALESCE(r.member_seen_id, 0)`, [owner]);
    return Number(rows?.[0]?.total) || 0;
  }
  const store = readDiskStore();
  return store.supportMessages.filter((item) => item.memberEmail === owner && item.role === 'admin' && item.id > (store.supportReads[owner]?.member || 0)).length;
}

export interface SessionBackupRecord { slot: string; generation: string; claimToken: string; revision: number; ciphertext: string; revoked: boolean; updatedAt: number }
function mapSessionBackup(row: Record<string, unknown>): SessionBackupRecord {
  return { slot: String(row.slot), generation: String(row.generation), claimToken: String(row.claim_token || ''), revision: Number(row.revision), ciphertext: String(row.ciphertext || ''), revoked: Boolean(Number(row.revoked)), updatedAt: Number(row.updated_at) };
}
/** Session recovery is deliberately unavailable on the ephemeral disk fallback. */
async function requireSessionBackupStorage(legacy: boolean): Promise<void> {
  if (!(await (legacy ? ensureFailoverTables() : ensureD1Tables()))) throw new Error('Recovery storage is unavailable.');
}
function requireBackupRows<T>(rows: T[] | null): T[] {
  if (rows === null) throw new Error('Recovery storage is unavailable.');
  return rows;
}
export async function listSessionBackupMetadata(after = '', legacy = false): Promise<Omit<SessionBackupRecord, 'ciphertext'>[]> {
  await requireSessionBackupStorage(legacy);
  const guard = legacy ? ` AND ${NO_FAILOVER_LEASE}` : '';
  const rows = requireBackupRows(await queryD1(`SELECT slot, generation, claim_token, revision, revoked, updated_at FROM portal_session_backups WHERE slot > ?${guard} ORDER BY slot LIMIT 100`, [after]));
  return rows.map((row) => { const { ciphertext: _ciphertext, ...rest } = mapSessionBackup(row); return rest; });
}
export async function getSessionBackup(slot: string, legacy = false): Promise<SessionBackupRecord | null> {
  await requireSessionBackupStorage(legacy);
  const guard = legacy ? ` AND ${NO_FAILOVER_LEASE}` : '';
  const rows = requireBackupRows(await queryD1(`SELECT * FROM portal_session_backups WHERE slot = ?${guard} LIMIT 1`, [slot]));
  return rows.length ? mapSessionBackup(rows[0]) : null;
}
/** Portal ownership data used to recheck a backup write in the same SQL statement. */
export interface SessionBackupClaim { key: string; owner: string }
export function sessionBackupClaim(user: Pick<ApprovedUser, 'claimId' | 'addedAt' | 'addedBy'>): { token: string; identity: SessionBackupClaim } {
  const identity = { key: String(user.claimId || user.addedAt || ''), owner: String(user.addedBy || '').toLowerCase() };
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
    WHERE u.number = ? AND COALESCE(NULLIF(u.claim_id, ''), u.added_at, '') = ?
      AND lower(COALESCE(u.added_by, '')) = ? AND COALESCE(p.allowed, 1) = 1
      AND (COALESCE(u.approval_status, 'approved') = 'pending'
        OR (COALESCE(u.approval_status, 'approved') = 'approved' AND u.enabled = 1)))`,
    params: [slot.slice(7), identity.key, identity.owner] };
}
/** Read the backup only if its ownership is still current at the SQL snapshot. */
export async function getEligibleSessionBackup(slot: string, claimToken: string, identity?: SessionBackupClaim | null, legacy = false): Promise<SessionBackupRecord | null> {
  await requireSessionBackupStorage(legacy);
  const check = backupEligibility(slot, identity);
  const guard = legacy ? ` AND ${NO_FAILOVER_LEASE}` : '';
  const rows = requireBackupRows(await queryD1(`SELECT * FROM portal_session_backups WHERE slot = ? AND claim_token = ? AND revoked = 0 AND ${check.sql}${guard} LIMIT 1`,
    [slot, claimToken, ...check.params]));
  return rows.length ? mapSessionBackup(rows[0]) : null;
}
/** Compare-and-swap and check the current claim and mode in the same SQL statement. */
export async function putSessionBackup(slot: string, generation: string, claimToken: string, ciphertext: string, expected: number, identity?: SessionBackupClaim | null, legacy = false): Promise<number | null> {
  await requireSessionBackupStorage(legacy);
  const check = backupEligibility(slot, identity);
  const guard = legacy ? ` AND ${NO_FAILOVER_LEASE}` : '';
  const rows = expected === 0
    ? await queryD1(`INSERT INTO portal_session_backups (slot, generation, claim_token, revision, ciphertext, revoked, updated_at)
        SELECT ?, ?, ?, 1, ?, 0, ? WHERE ${check.sql}${guard} ON CONFLICT(slot) DO NOTHING RETURNING revision`,
      [slot, generation, claimToken, ciphertext, Date.now(), ...check.params])
    : await queryD1(`UPDATE portal_session_backups SET generation = ?, claim_token = ?, revision = revision + 1, ciphertext = ?, revoked = 0, updated_at = ?
        WHERE slot = ? AND revision = ? AND (revoked = 0 OR generation != ?) AND ${check.sql}${guard} RETURNING revision`,
      [generation, claimToken, ciphertext, Date.now(), slot, expected, generation, ...check.params]);
  const result = requireBackupRows(rows);
  return result.length ? Number(result[0].revision) : null;
}
/** A delayed deletion can erase only the deleted owner's backup, never a replacement. */
async function revokeBackupForClaim(slot: string, claimToken: string): Promise<void> {
  if (!(await ensureD1Tables())) return;
  await queryD1(`UPDATE portal_session_backups SET revision = revision + 1, ciphertext = '', revoked = 1, updated_at = ?
    WHERE slot = ? AND claim_token = ?`, [Date.now(), slot, claimToken]);
}
export async function revokeSessionBackup(slot: string, generation?: string, legacy = false): Promise<boolean> {
  await requireSessionBackupStorage(legacy);
  // An old single-host request cannot race the first failover lease. A delayed
  // logout can also never revoke a newer generation of the same session.
  const guard = legacy ? NO_FAILOVER_LEASE : '1 = 1';
  const rows = await queryD1(`INSERT INTO portal_session_backups (slot, generation, claim_token, revision, ciphertext, revoked, updated_at)
    SELECT ?, ?, '', 1, '', 1, ? WHERE ${guard}
    ON CONFLICT(slot) DO UPDATE SET revision = portal_session_backups.revision + 1, ciphertext = '', revoked = 1, updated_at = excluded.updated_at
    ${generation ? 'WHERE portal_session_backups.generation = excluded.generation' : ''} RETURNING slot`, [slot, generation || '', Date.now()]);
  if (rows === null) throw new Error('Recovery storage is unavailable.');
  if (!legacy || rows.length) return true;
  // A generation mismatch is a safe no-op; distinguish it from a mode change.
  return !(await getFailoverStatus()).enabled;
}

export async function getPanelConnectionConfig(): Promise<PanelConnectionConfig> {
  // XS settings are separate from legacy panel_* values. A saved Botkeep key
  // must never be forwarded to XS, and the old server ID must not be powered.
  // Environment credentials are accepted only when they explicitly identify
  // this XS server and panel; otherwise the owner enters the XS key privately.
  const envMatchesXs = (process.env.PANEL_URL || '').trim().replace(/\/+$/, '') === DEFAULT_PANEL_URL &&
    [DEFAULT_XS_SERVER_ID, '381c9516-ac72-4b42-a4e3-e16bb7f9f4a0'].includes((process.env.PANEL_SERVER_ID || '').trim());
  const envKey = envMatchesXs ? (process.env.PANEL_API_KEY || '').trim() : '';
  const resolve = (map: Map<string, string>, updatedAt?: string): PanelConnectionConfig => {
    const panelUrl = (map.has('xs_panel_url') ? map.get('xs_panel_url')! : DEFAULT_PANEL_URL).trim() || DEFAULT_PANEL_URL;
    const panelServerId = (map.has('xs_panel_server_id') ? map.get('xs_panel_server_id')! : DEFAULT_XS_SERVER_ID).trim();
    const mayUseEnvKey = panelUrl.replace(/\/+$/, '') === DEFAULT_PANEL_URL &&
      [DEFAULT_XS_SERVER_ID, '381c9516-ac72-4b42-a4e3-e16bb7f9f4a0'].includes(panelServerId);
    return { panelUrl, panelServerId, panelApiKey: (map.has('xs_panel_api_key') ? map.get('xs_panel_api_key')! : mayUseEnvKey ? envKey : '').trim(), updatedAt };
  };
  if (await ensureD1Tables()) {
    const rows = (await queryD1(`SELECT key, value, updated_at FROM portal_settings
      WHERE key IN ('xs_panel_url', 'xs_panel_server_id', 'xs_panel_api_key')`)) || [];
    const map = new Map<string, string>();
    let updatedAt: string | undefined;
    for (const row of rows) {
      map.set(String(row.key), String(row.value));
      if (row.updated_at) updatedAt = String(row.updated_at);
    }
    return resolve(map, updatedAt);
  }
  const store = readDiskStore();
  return resolve(new Map(Object.entries(store.settings)), store.settings.xs_panel_updated_at);
}

export async function savePanelConnectionConfig(patch: {
  panelUrl?: string;
  panelServerId?: string;
  panelApiKey?: string;
}): Promise<PanelConnectionConfig> {
  const current = await getPanelConnectionConfig();
  const nextUrl =
    typeof patch.panelUrl === 'string'
      ? patch.panelUrl.trim() || DEFAULT_PANEL_URL
      : current.panelUrl;
  const nextServerId =
    typeof patch.panelServerId === 'string'
      ? patch.panelServerId.trim()
      : current.panelServerId;
  // Changing the panel URL never forwards the previous host's API key.
  const nextApiKey =
    typeof patch.panelApiKey === 'string'
      ? patch.panelApiKey.trim()
      : nextUrl === current.panelUrl ? current.panelApiKey : '';
  const now = new Date().toISOString();

  if (await ensureD1Tables()) {
    const entries: [string, string][] = [
      ['xs_panel_url', nextUrl],
      ['xs_panel_server_id', nextServerId],
      ['xs_panel_api_key', nextApiKey],
    ];
    for (const [k, v] of entries) {
      await queryD1(
        `INSERT INTO portal_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [k, v, now],
      );
    }
    return {
      panelUrl: nextUrl,
      panelServerId: nextServerId,
      panelApiKey: nextApiKey,
      updatedAt: now,
    };
  }

  const store = readDiskStore();
  store.settings.xs_panel_url = nextUrl;
  store.settings.xs_panel_server_id = nextServerId;
  store.settings.xs_panel_api_key = nextApiKey;
  store.settings.xs_panel_updated_at = now;
  writeDiskStore(store);

  return {
    panelUrl: nextUrl,
    panelServerId: nextServerId,
    panelApiKey: nextApiKey,
    updatedAt: now,
  };
}

export async function saveBotHeartbeat(hb: BotHeartbeatRecord, fence?: FailoverFence): Promise<void> {
  if (await ensureFailoverTables()) {
    const guard = fence ? CURRENT_FAILOVER_FENCE : NO_FAILOVER_LEASE;
    const values: (string | number)[] = [JSON.stringify(hb), new Date().toISOString()];
    if (fence) values.push(fence.role, fence.instance, fence.epoch);
    const rows = await queryD1(`INSERT INTO portal_settings (key, value, updated_at)
      SELECT 'bot_heartbeat_json', ?, ? WHERE ${guard}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at RETURNING key`, values);
    if (rows !== null) return;
  }
  if (fence || !mayUseStandaloneDisk()) throw new Error('Failover storage is unavailable.');
  await setSettingValue('bot_heartbeat_json', JSON.stringify(hb));
}

export async function getBotHeartbeat(): Promise<BotHeartbeatRecord | null> {
  const raw = await getSettingValue('bot_heartbeat_json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.lastSeenAt !== 'number') return null;
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

function canonicalWhitelist(users: ApprovedUser[]) {
  return users
    .map((u) => ({ number: u.number, label: u.label || '', enabled: Boolean(u.enabled), pairAllowed: u.pairAllowed === true, addedBy: (u.addedBy || '').toLowerCase(), claimId: u.claimId || '', addedAt: u.addedAt || '' }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

export function whitelistVersionFor(users: ApprovedUser[], botEnabledForMembers: boolean): string {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ botEnabledForMembers, users: canonicalWhitelist(users) }))
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
  const canonical = canonicalWhitelist(users);
  return {
    version: whitelistVersionFor(users, cfg.botEnabledForMembers),
    botEnabledForMembers: cfg.botEnabledForMembers,
    users,
    numbers: cfg.botEnabledForMembers ? canonical.filter((u) => u.enabled).map((u) => u.number) : [],
  };
}

export type FailoverRole = 'xs' | 'botkeep';
export interface FailoverIdentity { role: FailoverRole; instance: string }
export interface FailoverFence extends FailoverIdentity { epoch: number }
export interface FailoverLease extends FailoverIdentity {
  granted: boolean;
  epoch?: number;
  ttlMs?: number;
}
export type FailoverStatus = WhatsAppFailoverStatus;

const FAILOVER_TTL_MS = 30_000;
const XS_ABSENCE_MS = 15_000;
// The database clock makes each conditional lease operation atomic across
// dashboard instances. The bot also stops serving before this TTL elapses.
const D1_NOW_MS = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
const CURRENT_FAILOVER_FENCE = `EXISTS (SELECT 1 FROM portal_bot_failover
  WHERE id = 'whatsapp' AND owner_role = ? AND owner_instance = ? AND epoch = ? AND expires_at > ${D1_NOW_MS})`;
const NO_FAILOVER_LEASE = `NOT EXISTS (SELECT 1 FROM portal_bot_failover WHERE id = 'whatsapp')`;

/** A shared, expiring lease; never fall back to the local disk for coordination. */
export async function claimFailoverLease(identity: FailoverIdentity, state: {
  connected: boolean; version?: string; accountNumber: string; deviceFingerprint: string;
}): Promise<FailoverLease> {
  if (!['xs', 'botkeep'].includes(identity.role) || !/^[a-f0-9]{32}$/.test(identity.instance)) throw new Error('Invalid failover identity.');
  if (!await ensureFailoverTables()) throw new Error('Failover requires the shared Cloudflare D1 database.');
  const account = /^\d{7,15}$/.test(state.accountNumber) ? crypto.createHash('sha256').update(state.accountNumber).digest('hex') : '';
  const device = /^[a-f0-9]{64}$/.test(state.deviceFingerprint) ? state.deviceFingerprint : '';
  const ready = state.connected && Boolean(account && device);
  const initialized = await queryD1(`INSERT INTO portal_bot_failover (id, owner_role, owner_instance, expires_at, epoch)
    VALUES ('whatsapp', '', '', 0, 0) ON CONFLICT(id) DO NOTHING`);
  if (initialized === null) throw new Error('Failover storage is unavailable.');
  const seen = await queryD1(`INSERT INTO portal_bot_failover_nodes
    (role, instance, last_seen_at, connected, version, account_hash, device_fingerprint)
    VALUES (?, ?, ${D1_NOW_MS}, ?, ?, ?, ?)
    ON CONFLICT(role) DO UPDATE SET instance = excluded.instance, last_seen_at = excluded.last_seen_at,
      connected = excluded.connected, version = excluded.version,
      account_hash = CASE WHEN excluded.account_hash != '' THEN excluded.account_hash ELSE portal_bot_failover_nodes.account_hash END,
      device_fingerprint = CASE WHEN excluded.device_fingerprint != '' THEN excluded.device_fingerprint ELSE portal_bot_failover_nodes.device_fingerprint END`,
    [identity.role, identity.instance, ready ? 1 : 0, (state.version || '').slice(0, 80), account, device]);
  if (seen === null) throw new Error('Failover storage is unavailable.');

  // A backup is eligible only after XS has checked in at least once and has
  // subsequently disappeared or lost its WhatsApp connection. When XS returns,
  // backup renewal stops, but XS cannot preempt the still-live old lease.
  const rows = await queryD1<{ epoch: number }>(`UPDATE portal_bot_failover SET
    epoch = CASE WHEN owner_role = ? AND owner_instance = ? AND expires_at > ${D1_NOW_MS} THEN epoch ELSE epoch + 1 END,
    owner_role = ?, owner_instance = ?, expires_at = ${D1_NOW_MS} + ?
    WHERE id = 'whatsapp' AND ? = 1
      AND (expires_at <= ${D1_NOW_MS} OR (owner_role = ? AND owner_instance = ? AND expires_at > ${D1_NOW_MS}))
      AND (? = 'xs' OR EXISTS (SELECT 1 FROM portal_bot_failover_nodes
        WHERE role = 'xs' AND account_hash = ? AND length(device_fingerprint) = 64 AND device_fingerprint != ?
          AND (last_seen_at <= ${D1_NOW_MS} - ? OR connected = 0)))
    RETURNING epoch`, [identity.role, identity.instance, identity.role, identity.instance, FAILOVER_TTL_MS,
      ready ? 1 : 0, identity.role, identity.instance, identity.role, account, device, XS_ABSENCE_MS]);
  if (rows === null) throw new Error('Failover storage is unavailable.');
  return rows.length ? { ...identity, granted: true, epoch: Number(rows[0].epoch), ttlMs: FAILOVER_TTL_MS }
    : { ...identity, granted: false };
}

/** Only administrators receive this status; missing heartbeats are not inferred as connected. */
export async function getFailoverStatus(): Promise<FailoverStatus> {
  const empty: FailoverStatus = { enabled: false, activeRole: null, epoch: null, issue: null, xs: null, botkeep: null };
  if (!await ensureFailoverTables()) {
    if (!mayUseStandaloneDisk()) throw new Error('Failover status is unavailable while D1 is unreachable.');
    return empty;
  }
  const leases = await queryD1<{ owner_role: string; expires_at: number; now_ms: number; epoch: number }>(
    `SELECT owner_role, expires_at, epoch, ${D1_NOW_MS} AS now_ms FROM portal_bot_failover WHERE id = 'whatsapp'`);
  if (leases === null) {
    if (mayUseStandaloneDisk()) return empty;
    throw new Error('Failover status is unavailable while D1 is unreachable.');
  }
  if (!leases.length) return empty;
  const nodes = await queryD1<{ role: string; last_seen_at: number; connected: number | null; version: string; account_hash: string; device_fingerprint: string }>(
    'SELECT role, last_seen_at, connected, version, account_hash, device_fingerprint FROM portal_bot_failover_nodes');
  if (nodes === null) {
    if (mayUseStandaloneDisk()) return empty;
    throw new Error('Failover storage is unavailable.');
  }
  for (const row of nodes) {
    if (row.role === 'xs' || row.role === 'botkeep') empty[row.role] = {
      lastSeenAt: Number(row.last_seen_at), connected: row.connected === null ? null : Boolean(row.connected), version: row.version || '',
    };
  }
  const primary = nodes.find((node) => node.role === 'xs');
  const backup = nodes.find((node) => node.role === 'botkeep');
  const issue = primary?.account_hash && backup?.account_hash && primary.device_fingerprint && backup.device_fingerprint
    ? primary.account_hash !== backup.account_hash ? 'different-account'
      : primary.device_fingerprint === backup.device_fingerprint ? 'shared-session' : null
    : null;
  const lease = leases[0];
  const owner = lease.owner_role;
  const activeRole = Number(lease.expires_at) > Number(lease.now_ms) && (owner === 'xs' || owner === 'botkeep') ? owner : null;
  return { ...empty, enabled: true, activeRole, issue, epoch: activeRole ? Number(lease.epoch) : null };
}

/** Import without replacing a dashboard member; atomically check the current mode/lease. */
export async function importLocalUserForLease(number: string, label: string, addedBy: string, fence?: FailoverFence): Promise<boolean> {
  if (await ensureFailoverTables()) {
    const guard = fence ? CURRENT_FAILOVER_FENCE : NO_FAILOVER_LEASE;
    const params: (string | number)[] = [number, label, addedBy.trim().toLowerCase(), new Date().toISOString(), crypto.randomUUID()];
    if (fence) params.push(fence.role, fence.instance, fence.epoch);
    const rows = await queryD1(`INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at, approval_status, claim_id)
      SELECT ?, ?, 1, ?, ?, 'approved', ? WHERE ${guard}
      ON CONFLICT(number) DO NOTHING RETURNING number`, params);
    if (rows !== null) return rows.length > 0;
  }
  if (fence || !mayUseStandaloneDisk()) throw new Error('Failover storage is unavailable.');
  if (await getStoredWhatsAppUser(number)) return false;
  await saveStoredWhatsAppUser(number, label, addedBy);
  return true;
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
  type: BotCommandRecord['type'];
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

  if (await ensureD1Tables()) {
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
  } else {
    const store = readDiskStore();
    store.botCommands = store.botCommands.filter((c) => c.expiresAt >= now - 300_000);
    store.botCommands.push(cmd);
    writeDiskStore(store);
  }

  await setFastPollWindow(60_000);
  return cmd;
}

/** Recover an accepted request after a refresh without exposing another member's code. */
export async function getLatestPairCommand(number: string, requestedBy: string, since: number): Promise<BotCommandRecord | null> {
  const owner = requestedBy.toLowerCase();
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT * FROM portal_bot_commands WHERE type = 'pair' AND lower(requested_by) = ?
       AND json_extract(payload_json, '$.number') = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`, [owner, number, since],
    );
    return rows?.length ? mapD1BotCommand(rows[0]) : null;
  }
  return readDiskStore().botCommands.filter((cmd) => cmd.type === 'pair' && cmd.payload.number === number &&
    (cmd.requestedBy || '').toLowerCase() === owner && cmd.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

/** Direct responses also get a short-lived recovery record, never a queue entry. */
export async function saveCompletedPairResult(params: {
  number: string; requestedBy: string; createdAt: number; code: string; issuedAt: number; expiresInSeconds: number;
}): Promise<void> {
  const result = JSON.stringify({ code: params.code, issuedAt: params.issuedAt,
    expiresInSeconds: params.expiresInSeconds, _dashboardReceivedAt: Date.now() });
  const id = `pair_${params.createdAt.toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const expiresAt = params.createdAt + 90_000;
  if (await ensureD1Tables()) {
    await queryD1(`DELETE FROM portal_bot_commands WHERE expires_at < ?`, [Date.now() - 300_000]);
    await queryD1(
      `INSERT INTO portal_bot_commands (id, type, payload_json, status, result_json, error_text, requested_by, created_at, expires_at)
       VALUES (?, 'pair', ?, 'completed', ?, NULL, ?, ?, ?)`,
      [id, JSON.stringify({ number: params.number }), result, params.requestedBy.toLowerCase(), params.createdAt, expiresAt],
    );
    return;
  }
  const store = readDiskStore();
  store.botCommands = store.botCommands.filter((c) => c.expiresAt >= Date.now() - 300_000);
  store.botCommands.push({ id, type: 'pair', payload: { number: params.number }, status: 'completed', result: JSON.parse(result),
    requestedBy: params.requestedBy.toLowerCase(), createdAt: params.createdAt, expiresAt });
  writeDiskStore(store);
}

export async function claimPendingBotCommands(fence?: FailoverFence): Promise<BotCommandRecord[]> {
  const now = Date.now();

  if (await ensureFailoverTables()) {
    // Selection and claiming must be a single database operation: two
    // simultaneous polls must never receive the same command. Legacy polls
    // also fail atomically if failover became enabled during their request.
    const guard = fence ? CURRENT_FAILOVER_FENCE : NO_FAILOVER_LEASE;
    const rows = await queryD1(`UPDATE portal_bot_commands SET status = 'claimed'
      WHERE id IN (SELECT id FROM portal_bot_commands WHERE status = 'pending' AND expires_at >= ?
        ORDER BY created_at ASC LIMIT 10) AND status = 'pending' AND ${guard} RETURNING *`,
      fence ? [now, fence.role, fence.instance, fence.epoch] : [now]);
    if (rows !== null) return rows.map(mapD1BotCommand);
  }
  if (fence || !mayUseStandaloneDisk()) throw new Error('Failover requires the shared Cloudflare D1 database.');

  const store = readDiskStore();
  const claimed: BotCommandRecord[] = [];
  for (const c of store.botCommands) {
    if (c.status === 'pending' && c.expiresAt >= now) {
      c.status = 'claimed';
      claimed.push({ ...c });
    }
  }
  if (claimed.length > 0) writeDiskStore(store);
  return claimed;
}

export async function completeBotCommand(params: {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}, fence?: FailoverFence): Promise<void> {
  const status: BotCommandRecord['status'] = params.ok ? 'completed' : 'failed';
  // Record receipt on the dashboard clock once. It is a fixed upper bound for
  // checking a service-provided issuance timestamp on subsequent polls.
  const result = params.result ? { ...params.result, _dashboardReceivedAt: Date.now() } : null;
  const resultJson = result ? JSON.stringify(result) : null;
  const errorText = params.error ? String(params.error).slice(0, 400) : null;

  if (await ensureFailoverTables()) {
    const guard = fence ? CURRENT_FAILOVER_FENCE : NO_FAILOVER_LEASE;
    const rows = await queryD1(
      `UPDATE portal_bot_commands
       SET status = ?, result_json = ?, error_text = ?
       WHERE id = ? AND status IN ('pending', 'claimed') AND ${guard}`,
      fence ? [status, resultJson, errorText, params.id, fence.role, fence.instance, fence.epoch]
        : [status, resultJson, errorText, params.id],
    );
    if (rows !== null) return;
  }
  if (fence || !mayUseStandaloneDisk()) throw new Error('Failover requires the shared Cloudflare D1 database.');

  const store = readDiskStore();
  const found = store.botCommands.find((c) => c.id === params.id);
  if (found && (found.status === 'pending' || found.status === 'claimed')) {
    found.status = status;
    found.result = result;
    found.error = errorText;
    writeDiskStore(store);
  }
}

export async function getBotCommandById(
  id: string,
): Promise<BotCommandRecord | null> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT * FROM portal_bot_commands WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows || rows.length === 0) return null;
    return mapD1BotCommand(rows[0]);
  }
  return readDiskStore().botCommands.find((c) => c.id === id) || null;
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
  if (await ensureD1Tables()) {
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
  const store = readDiskStore();
  store.activity = [entry, ...store.activity].slice(0, 1000);
  writeDiskStore(store);
}

export async function listRecentActivity(limit = 100): Promise<ActivityEvent[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 100));
  if (await ensureD1Tables()) {
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
  return readDiskStore().activity.slice(0, safeLimit);
}

// ---------------------------------------------------------------------------
// Legacy Scribd panel settings (not used by the current web-service adapter).
// ---------------------------------------------------------------------------
// Retained for compatibility with existing stored settings. The defaults here
// must not diverge from the current web-service address.
export const DEFAULT_SCRIBD_PANEL_URL = DEFAULT_SCRIBD_WEB_URL;

export async function getScribdConnectionConfig(): Promise<ScribdConnectionConfig> {
  const envUrl = (process.env.SCRIBD_PANEL_URL || DEFAULT_SCRIBD_PANEL_URL).trim();
  const envKey = (process.env.SCRIBD_PANEL_KEY || '').trim();

  if (await ensureD1Tables()) {
    const rows =
      (await queryD1(
        `SELECT key, value, updated_at FROM portal_settings
         WHERE key IN ('scribd_panel_url', 'scribd_panel_key')`,
      )) || [];
    const map = new Map<string, string>();
    let updatedAt: string | undefined;
    for (const r of rows) {
      map.set(String(r.key), String(r.value));
      if (r.updated_at) updatedAt = String(r.updated_at);
    }
    return {
      panelUrl: (map.get('scribd_panel_url') || envUrl).trim(),
      panelKey: (map.get('scribd_panel_key') ?? envKey).trim(),
      updatedAt,
    };
  }

  const store = readDiskStore();
  return {
    panelUrl: (store.settings.scribd_panel_url || envUrl).trim(),
    panelKey: (store.settings.scribd_panel_key ?? envKey).trim(),
    updatedAt: store.settings.scribd_panel_updated_at,
  };
}

export async function saveScribdConnectionConfig(patch: {
  panelUrl?: string;
  panelKey?: string;
}): Promise<ScribdConnectionConfig> {
  const current = await getScribdConnectionConfig();
  const nextUrl =
    typeof patch.panelUrl === 'string'
      ? patch.panelUrl.trim() || DEFAULT_SCRIBD_PANEL_URL
      : current.panelUrl;
  // An empty key is a real value here: it means "this panel is not locked".
  const nextKey =
    typeof patch.panelKey === 'string' ? patch.panelKey.trim() : current.panelKey;
  const now = new Date().toISOString();

  if (await ensureD1Tables()) {
    const entries: [string, string][] = [
      ['scribd_panel_url', nextUrl],
      ['scribd_panel_key', nextKey],
    ];
    for (const [k, v] of entries) {
      await queryD1(
        `INSERT INTO portal_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [k, v, now],
      );
    }
    return { panelUrl: nextUrl, panelKey: nextKey, updatedAt: now };
  }

  const store = readDiskStore();
  store.settings.scribd_panel_url = nextUrl;
  store.settings.scribd_panel_key = nextKey;
  store.settings.scribd_panel_updated_at = now;
  writeDiskStore(store);

  return { panelUrl: nextUrl, panelKey: nextKey, updatedAt: now };
}
