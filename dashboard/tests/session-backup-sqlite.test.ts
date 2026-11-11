// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteWhatsAppUserIfOwned, getEligibleSessionBackup, getSessionBackup, putSessionBackup, revokeSessionBackup, sessionBackupClaim } from '../lib/storage';

let db: DatabaseSync;
let afterDelete: (() => void) | null;
const number = '265991234567';
const slot = `linked:${number}`;
const one = sessionBackupClaim({ claimId: 'claim-one', addedAt: '2026-01-01', addedBy: 'one@example.com' });
const two = sessionBackupClaim({ claimId: 'claim-two', addedAt: '2026-01-02', addedBy: 'two@example.com' });
const three = sessionBackupClaim({ claimId: 'claim-three', addedAt: '2026-01-03', addedBy: 'three@example.com' });
const gen1 = 'a'.repeat(24); const gen2 = 'b'.repeat(24); const gen3 = 'c'.repeat(24);

beforeEach(() => {
  db = new DatabaseSync(':memory:'); afterDelete = null;
  db.exec(`CREATE TABLE portal_whatsapp_access (number TEXT PRIMARY KEY, label TEXT, enabled INTEGER, added_by TEXT, added_at TEXT, approval_status TEXT, claim_id TEXT);
    CREATE TABLE portal_member_permissions (email TEXT PRIMARY KEY, allowed INTEGER);
    CREATE TABLE portal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE portal_session_backups (slot TEXT PRIMARY KEY, generation TEXT, claim_token TEXT, revision INTEGER, ciphertext TEXT, revoked INTEGER, updated_at INTEGER);`);
  globalThis.__zafarD1SchemaV6Ready = true;
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test'); vi.stubEnv('D1_DATABASE_ID', 'test'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
    try {
      const rows = db.prepare(sql).all(...params);
      if (/DELETE FROM portal_whatsapp_access/.test(sql) && afterDelete) { const hook = afterDelete; afterDelete = null; hook(); }
      return Response.json({ success: true, result: [{ results: rows }] });
    } catch (error) { return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 }); }
  }));
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); globalThis.__zafarD1SchemaV6Ready = undefined; globalThis.__zafarD1SchemaV6Promise = undefined; });
function owner(email: string, claim: string, date: string) {
  db.prepare(`INSERT OR REPLACE INTO portal_whatsapp_access VALUES (?, 'Member', 1, ?, ?, 'approved', ?)`).run(number, email, date, claim);
}

describe('backup SQL against a local SQLite D1 stand-in', () => {
  it('atomically rejects stale ownership, revocation and revisions', async () => {
    owner('one@example.com', 'claim-one', '2026-01-01');
    expect(await putSessionBackup(slot, gen1, one.token, 'encrypted-one', 0, one.identity)).toBe(1);
    expect(await getEligibleSessionBackup(slot, one.token, one.identity)).toMatchObject({ generation: gen1 });
    owner('two@example.com', 'claim-two', '2026-01-02');
    expect(await deleteWhatsAppUserIfOwned(number, 'two@example.com', 'claim-one')).toBe(false);
    expect(await getEligibleSessionBackup(slot, one.token, one.identity)).toBeNull();
    expect(await putSessionBackup(slot, gen1, one.token, 'stale', 1, one.identity)).toBeNull();
    expect(await putSessionBackup(slot, gen2, two.token, 'encrypted-two', 1, two.identity)).toBe(2);
    await revokeSessionBackup(slot, gen1);
    expect(await getSessionBackup(slot)).toMatchObject({ generation: gen2, revision: 2, revoked: false });
    await revokeSessionBackup(slot, gen2);
    expect(await putSessionBackup(slot, gen2, two.token, 'resurrection', 3, two.identity)).toBeNull();
    expect(await putSessionBackup(slot, gen3, two.token, 'new-link', 2, two.identity)).toBeNull();
    expect(await putSessionBackup(slot, gen3, two.token, 'new-link', 3, two.identity)).toBe(4);
  });
  it('does not revoke a new claim when an old deletion finishes late', async () => {
    owner('two@example.com', 'claim-two', '2026-01-02');
    expect(await putSessionBackup(slot, gen2, two.token, 'old', 0, two.identity)).toBe(1);
    afterDelete = () => {
      owner('three@example.com', 'claim-three', '2026-01-03');
      db.prepare(`UPDATE portal_session_backups SET generation = ?, claim_token = ?, revision = 2, ciphertext = 'new' WHERE slot = ?`).run(gen3, three.token, slot);
    };
    expect(await deleteWhatsAppUserIfOwned(number, 'two@example.com')).toBe(true);
    expect(await getSessionBackup(slot)).toMatchObject({ generation: gen3, claimToken: three.token, revision: 2, revoked: false, ciphertext: 'new' });
  });
});
