// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ text: null as string | null, fail: false }));
vi.mock('node:fs', () => ({
  default: {
    existsSync: () => disk.text !== null,
    readFileSync: () => disk.text,
    mkdirSync: () => { if (disk.fail) throw new Error('read-only'); },
    writeFileSync: (_path: string, value: string) => { if (disk.fail) throw new Error('read-only'); disk.text = value; },
  },
}));
import { appendActivity, claimPairCooldown, completeBotCommand, deleteWhatsAppUserIfOwned, enqueueBotCommand, getBotCommandById, getLatestPairCommand, getPairCooldown, getStoredWhatsAppUser, updateStoredWhatsAppUser, resolvePendingWhatsAppUser, setMemberPermission, getMemberCommandPolicy, setMemberCommandDisabled, addSupportMessage, listSupportMessages, listSupportThreads, countMemberSupportUnread, listRecentActivity, releasePairCooldown, saveCompletedPairResult, saveMemberWhatsAppUser, saveStoredWhatsAppUser } from '../lib/storage';
import { whitelistVersionFor } from '../lib/storage';
import { maskedNumber } from '../lib/activity';

beforeEach(() => {
  disk.text = null;
  disk.fail = false;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.D1_DATABASE_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

afterEach(() => vi.useRealTimers());

describe('local control-room persistence', () => {
  it('records bounded, masked activity rather than full phone numbers', async () => {
    const detail = maskedNumber('+265 991 234 567');
    await appendActivity({ category: 'numbers', action: 'Number added', actor: 'OWNER@example.com', outcome: 'success', detail });
    await appendActivity({ category: 'members', action: 'Member blocked', actor: 'owner@example.com', outcome: 'success', detail: 'member@example.com' });
    const events = await listRecentActivity(1);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('Member blocked');
    const saved = JSON.parse(disk.text!);
    expect(saved.activity[1]).toMatchObject({ actor: 'owner@example.com', detail: 'Number ending 4567' });
    expect(disk.text).not.toContain('265991234567');
  });

  it('records the first result receipt once, ignoring repeated reports', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    const cmd = await enqueueBotCommand({ type: 'pair', payload: { number: '15550001111' } });
    await vi.advanceTimersByTimeAsync(1_000);
    const receivedAt = Date.now();
    await completeBotCommand({ id: cmd.id, ok: true, result: { code: 'FIRST', _dashboardReceivedAt: 1 } });
    await vi.advanceTimersByTimeAsync(5_000);
    await completeBotCommand({ id: cmd.id, ok: true, result: { code: 'SECOND' } });
    expect(await getBotCommandById(cmd.id)).toMatchObject({
      status: 'completed', result: { code: 'FIRST', _dashboardReceivedAt: receivedAt },
    });
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
    disk.text = JSON.stringify({ whatsappUsers: [{ number: '11111111', enabled: true, addedBy: 'old@example.com' }] });
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
    disk.text = JSON.stringify({ whatsappUsers: [{ number: '11111111', enabled: true, approval: 'unexpected' }] });
    expect(await getStoredWhatsAppUser('11111111')).toMatchObject({ approval: 'rejected', enabled: false, pairAllowed: false });
  });

  it('stores independent command switches with a version that changes on each policy change', async () => {
    const original = await getMemberCommandPolicy();
    await setMemberCommandDisabled('movie', true); await setMemberCommandDisabled('song', true);
    const changed = await getMemberCommandPolicy();
    expect(changed.disabled).toEqual(['movie', 'song']);
    expect(changed.version).not.toBe(original.version);
    await setMemberCommandDisabled('movie', false);
    expect((await getMemberCommandPolicy()).disabled).toEqual(['song']);
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

  it('does not report successful permission changes when local storage is read-only', async () => {
    disk.fail = true;
    await expect(setMemberPermission('member@example.com', false)).rejects.toThrow(/storage is unavailable/i);
  });

  it('does not overwrite a corrupt local store with an empty one', async () => {
    disk.text = '{not valid json';
    await expect(setMemberPermission('member@example.com', false)).rejects.toThrow(/could not be read/i);
    expect(disk.text).toBe('{not valid json');
  });
});
