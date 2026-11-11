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

export async function queryD1<T = Record<string, unknown>>(
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

/** D1 is the only store. Fail loudly rather than pretending state was saved. */
export async function requireD1(): Promise<void> {
  if (!(await ensureD1Tables())) throw new Error(D1_REQUIRED);
}

export async function ensureD1Tables(): Promise<boolean> {
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

export async function isUsingCloudflareD1(): Promise<boolean> {
  return ensureD1Tables();
}
