// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSqliteD1, stopSqliteD1 } from './helpers/sqlite-d1';
import { appendActivity, claimPairCooldown, completeBotCommand, deleteWhatsAppUserIfOwned, enqueueBotCommand, getBotCommandById, getLatestPairCommand, getPairCooldown, getStoredWhatsAppUser, updateStoredWhatsAppUser, resolvePendingWhatsAppUser, setMemberPermission, addSupportMessage, listSupportMessages, listSupportThreads, countMemberSupportUnread, listRecentActivity, releasePairCooldown, saveCompletedPairResult, saveMemberWhatsAppUser, saveStoredWhatsAppUser, serializeWhitelistUsers } from '../lib/storage';
import { whitelistVersionFor } from '../lib/storage';
import { maskedNumber } from '../lib/activity';

let db: DatabaseSync;
let control: ReturnType<typeof startSqliteD1>;

beforeEach(() => {
  control = startSqliteD1();
  db = control.db;
});

afterEach(() => stopSqliteD1(db));

describe('control-room persistence on D1', () => {
  it('records bounded, masked activity rather than full phone numbers', async () => {
    const detail = maskedNumber('+265 991 234 567');
    await appendActivity({ category: 'numbers', action: 'Number added', actor: 'OWNER@example.com', outcome: 'success', detail });
    await appendActivity({ category: 'members', action: 'Member blocked', actor: 'owner@example.com', outcome: 'success', detail: 'member@example.com' });
    const events = await listRecentActivity(1);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('Member blocked');
    const rows = db.prepare('SELECT * FROM portal_activity').all() as Record<string, unknown>[];
    expect(rows.find((row) => row.action === 'Number added')).toMatchObject({ actor: 'owner@example.com', detail: 'Number ending 4567' });
    expect(JSON.stringify(rows)).not.toContain('265991234567');
  });

  it('records the first result receipt once, ignoring repeated reports', async () => {
    const before = Date.now();
    const cmd = await enqueueBotCommand({ type: 'pair', payload: { number: '15550001111' } });
    const receivedAt = Date.now();
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    await completeBotCommand({ id: cmd.id, ok: true, result: { code: 'FIRST', _dashboardReceivedAt: 1 } });
    await completeBotCommand({ id: cmd.id, ok: true, result: { code: 'SECOND' } });
    const stored = await getBotCommandById(cmd.id);
    expect(stored).toMatchObject({ status: 'completed', result: { code: 'FIRST' } });
    expect(Number((stored!.result as { _dashboardReceivedAt: number })._dashboardReceivedAt))
      .toBeGreaterThanOrEqual(before);
  });

  it('keeps claim IDs stable and serializes the bot whitelist contract fields', async () => {
    await saveStoredWhatsAppUser('265991234567', 'Member', 'Owner@Example.com');
    const initial = await getStoredWhatsAppUser('265991234567');
    expect(initial?.claimId).toBeTruthy();
    await saveStoredWhatsAppUser('265991234567', 'Renamed', 'new-owner@example.com');
    const transferred = await getStoredWhatsAppUser('265991234567');
    expect(transferred?.claimId).toBe(initial?.claimId);
    const [wire] = serializeWhitelistUsers([transferred!]);
    expect(wire).toMatchObject({ number: '265991234567', addedBy: 'new-owner@example.com', claimId: initial?.claimId, enabled: true, approval: 'approved' });
    expect(typeof wire.addedAt).toBe('number');
    expect(wire).not.toHaveProperty('pairAllowed');
  });

  it('persists a three-minute phone cooldown and releases only the matching attempt', async () => {
    const now = Date.now();
    const first = await claimPairCooldown('265991234567', now);
    expect(first).toEqual({ ok: true, retryAt: now + 180_000 });
    expect(await claimPairCooldown('265991234567', now + 1_000)).toEqual({ ok: false, retryAt: first.retryAt });
    await releasePairCooldown('265991234567', first.retryAt + 1);
    expect(await getPairCooldown('265991234567')).toBe(first.retryAt);
    expect(await claimPairCooldown('265991234567', first.retryAt)).toEqual({ ok: true, retryAt: first.retryAt + 180_000 });
  });

  it('recovers a direct result only by phone and requester, and removes only the current owner', async () => {
    const now = Date.now();
    await saveCompletedPairResult({ number: '265991234567', requestedBy: 'MEMBER@example.com', createdAt: now,
      code: 'TESTCODE', issuedAt: now, expiresInSeconds: 60 });
    expect(await getLatestPairCommand('265991234567', 'member@example.com', now)).toMatchObject({ status: 'completed', result: { code: 'TESTCODE' } });
    expect(await getLatestPairCommand('265991234567', 'other@example.com', now)).toBeNull();
    await saveStoredWhatsAppUser('265991234567', 'Member', 'member@example.com');
    expect(await deleteWhatsAppUserIfOwned('265991234567', 'other@example.com')).toBe(false);
    expect(await deleteWhatsAppUserIfOwned('265991234567', 'MEMBER@example.com')).toBe(true);
  });

  it('cannot transfer a number between member accounts during a claim', async () => {
    expect(await saveMemberWhatsAppUser('265991234567', 'Maya', 'MAYA@example.com')).toBe(true);
    expect(await saveMemberWhatsAppUser('265991234567', 'Other', 'other@example.com')).toBe(false);
    expect(await saveMemberWhatsAppUser('265991234567', 'Maya again', 'maya@example.com')).toBe(true);
    expect(await deleteWhatsAppUserIfOwned('265991234567', 'other@example.com')).toBe(false);
    expect(await deleteWhatsAppUserIfOwned('265991234567', 'maya@example.com')).toBe(true);
  });

  it('grandfathers old numbers but requires approval for each new member link', async () => {
    db.prepare(`INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at, approval_status, claim_id)
      VALUES ('11111111', 'Legacy', 1, 'old@example.com', ?, 'approved', 'legacy-claim')`).run(new Date().toISOString());
    expect(await getStoredWhatsAppUser('11111111')).toMatchObject({ approval: 'approved', enabled: true });
    expect(await saveMemberWhatsAppUser('265991234567', 'Maya', 'maya@example.com')).toBe(true);
    expect(await getStoredWhatsAppUser('265991234567')).toMatchObject({ approval: 'pending', enabled: false, pairAllowed: true });
    expect(await saveMemberWhatsAppUser('265991234568', 'Second', 'maya@example.com')).toBe(false);
    await updateStoredWhatsAppUser('265991234567', { enabled: true });
    expect(await getStoredWhatsAppUser('265991234567')).toMatchObject({ approval: 'pending', enabled: false });
    await setMemberPermission('maya@example.com', false);
    expect(await getStoredWhatsAppUser('265991234567')).toMatchObject({ enabled: false, pairAllowed: false });
    expect(await resolvePendingWhatsAppUser('265991234567', 'maya@example.com', true)).toBeNull();
    await setMemberPermission('maya@example.com', true);
    expect(await getStoredWhatsAppUser('265991234567')).toMatchObject({ approval: 'pending', enabled: false, pairAllowed: true });
    expect(await resolvePendingWhatsAppUser('265991234567', 'other@example.com', true)).toBeNull();
    expect(await resolvePendingWhatsAppUser('265991234567', 'maya@example.com', true)).toMatchObject({ approval: 'approved', enabled: true, pairAllowed: false });
  });

  it('allows a pending number to link but never enables a rejected or unknown state', async () => {
    expect(await saveMemberWhatsAppUser('265991234567', 'Maya', 'maya@example.com')).toBe(true);
    const pending = await getStoredWhatsAppUser('265991234567');
    expect(pending).toMatchObject({ approval: 'pending', enabled: false, pairAllowed: true });
    expect(await resolvePendingWhatsAppUser('265991234567', 'maya@example.com', false))
      .toMatchObject({ approval: 'rejected', enabled: false, pairAllowed: false });
    const rejected = await getStoredWhatsAppUser('265991234567');
    expect(rejected).toMatchObject({ approval: 'rejected', enabled: false, pairAllowed: false });
    expect(whitelistVersionFor([pending!], true)).not.toBe(whitelistVersionFor([rejected!], true));
    const samePermissions = { ...pending!, pairAllowed: false };
    expect(whitelistVersionFor([samePermissions], true)).not.toBe(whitelistVersionFor([rejected!], true));
    db.prepare(`INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at, approval_status, claim_id)
      VALUES ('11111111', 'Legacy', 1, 'old@example.com', ?, 'unexpected', 'legacy-claim')`).run(new Date().toISOString());
    expect(await getStoredWhatsAppUser('11111111')).toMatchObject({ approval: 'rejected', enabled: false, pairAllowed: false });
  });

  it('persists separate support conversations, read positions and send throttles', async () => {
    expect(await addSupportMessage('one@example.com', 'member', 'Help', 10000)).toMatchObject({ text: 'Help' });
    expect(await addSupportMessage('one@example.com', 'member', 'Too soon', 12000)).toBeNull();
    await addSupportMessage('two@example.com', 'member', 'A different problem', 12000);
    await addSupportMessage('one@example.com', 'admin', 'I can help', 12001);
    expect(await countMemberSupportUnread('one@example.com')).toBe(1);
    expect(await countMemberSupportUnread('two@example.com')).toBe(0);
    expect((await listSupportThreads()).find((thread) => thread.email === 'one@example.com')?.unread).toBe(1);
    expect((await listSupportMessages('one@example.com', 'member')).map((message) => message.text)).toEqual(['Help', 'I can help']);
    expect(await countMemberSupportUnread('one@example.com')).toBe(0);
    await listSupportMessages('one@example.com', 'admin');
    expect((await listSupportThreads()).find((thread) => thread.email === 'one@example.com')?.unread).toBe(0);
  });

  it('fails loudly instead of reporting a write that the database rejected', async () => {
    control.breakQueries(true);
    await expect(setMemberPermission('member@example.com', false)).rejects.toThrow(/unreachable/);
    control.breakQueries(false);
    const row = db.prepare(`SELECT allowed FROM portal_member_permissions WHERE email = 'member@example.com'`).get();
    expect(row).toBeUndefined();
  });

  it('does not answer from an empty store when the database is unreachable', async () => {
    await saveStoredWhatsAppUser('265991234567', 'Member', 'member@example.com');
    control.breakQueries(true);
    await expect(getStoredWhatsAppUser('265991234567')).rejects.toThrow(/unreachable/);
    control.breakQueries(false);
    expect(await getStoredWhatsAppUser('265991234567')).toMatchObject({ number: '265991234567' });
  });
});
