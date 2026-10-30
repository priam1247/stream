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
import { appendActivity, claimPairCooldown, completeBotCommand, deleteWhatsAppUserIfOwned, enqueueBotCommand, getBotCommandById, getLatestPairCommand, getPairCooldown, isMemberScribdAllowed, listRecentActivity, releasePairCooldown, saveCompletedPairResult, saveMemberWhatsAppUser, saveStoredWhatsAppUser, setMemberScribdAllowed } from '../lib/storage';
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
  it('defaults Scribd access to private and stores individual grants and revocations', async () => {
    expect(await isMemberScribdAllowed('member@example.com')).toBe(false);
    await setMemberScribdAllowed(' MEMBER@example.com ', true);
    expect(await isMemberScribdAllowed('member@example.com')).toBe(true);
    expect(await isMemberScribdAllowed('other@example.com')).toBe(false);
    await setMemberScribdAllowed('MEMBER@example.com', false);
    expect(await isMemberScribdAllowed('member@example.com')).toBe(false);
  });

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

  it('does not report successful permission changes when local storage is read-only', async () => {
    disk.fail = true;
    await expect(setMemberScribdAllowed('member@example.com', true)).rejects.toThrow(/storage is unavailable/i);
  });

  it('does not overwrite a corrupt local store with an empty one', async () => {
    disk.text = '{not valid json';
    await expect(setMemberScribdAllowed('member@example.com', true)).rejects.toThrow(/could not be read/i);
    expect(disk.text).toBe('{not valid json');
  });
});
