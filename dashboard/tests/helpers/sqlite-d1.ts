import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';

/**
 * A D1 stand-in for tests: an in-memory SQLite database reached through the
 * same `fetch` shape the dashboard uses against the Cloudflare API. The
 * dashboard has no other storage engine, so every storage test runs here.
 */
export interface SqliteD1 {
  db: DatabaseSync;
  /** Make the next query fail the way an unreachable D1 would. */
  breakQueries: (broken: boolean) => void;
}

const SCHEMA = `
  CREATE TABLE portal_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, password_hash TEXT NOT NULL, is_verified INTEGER NOT NULL DEFAULT 0,
    verification_code TEXT, code_expires_at TEXT, verification_attempts INTEGER NOT NULL DEFAULT 0,
    reset_code TEXT, reset_expires_at TEXT, reset_attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE portal_whatsapp_access (number TEXT PRIMARY KEY, label TEXT, enabled INTEGER,
    added_by TEXT, added_at TEXT, approval_status TEXT DEFAULT 'approved', claim_id TEXT);
  CREATE TABLE portal_member_permissions (email TEXT PRIMARY KEY, name TEXT, allowed INTEGER, updated_at TEXT);
  CREATE TABLE portal_activity (id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL,
    actor TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE portal_bot_commands (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, result_json TEXT, error_text TEXT, requested_by TEXT, created_at INTEGER, expires_at INTEGER);
  CREATE TABLE portal_pair_cooldowns (number TEXT PRIMARY KEY, retry_at INTEGER NOT NULL);
  CREATE TABLE portal_support_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, member_email TEXT NOT NULL,
    sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE portal_support_reads (member_email TEXT PRIMARY KEY, admin_seen_id INTEGER NOT NULL DEFAULT 0,
    member_seen_id INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE portal_session_backups (slot TEXT PRIMARY KEY, generation TEXT NOT NULL DEFAULT '',
    claim_token TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, ciphertext TEXT NOT NULL DEFAULT '',
    revoked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
  CREATE TABLE portal_bot_failover (id TEXT PRIMARY KEY, owner_role TEXT, owner_instance TEXT, expires_at INTEGER, epoch INTEGER);
`;

type Globals = typeof globalThis & {
  __zafarD1SchemaV6Ready?: boolean;
  __zafarD1SchemaV6Promise?: Promise<boolean> | undefined;
};

export function startSqliteD1(): SqliteD1 {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const g = globalThis as Globals;
  g.__zafarD1SchemaV6Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('D1_DATABASE_ID', 'test-database');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');

  let broken = false;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    if (broken) throw new Error('D1 unreachable');
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
    try {
      return Response.json({ success: true, result: [{ results: db.prepare(sql).all(...params) }] });
    } catch (error) {
      return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 });
    }
  });
  vi.stubGlobal('fetch', fetchMock);

  return { db, breakQueries: (value: boolean) => { broken = value; } };
}

export function stopSqliteD1(db: DatabaseSync): void {
  db.close();
  const g = globalThis as Globals;
  g.__zafarD1SchemaV6Ready = undefined;
  g.__zafarD1SchemaV6Promise = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
}
