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
import { appendActivity, completeBotCommand, enqueueBotCommand, getBotCommandById, isMemberScribdAllowed, listRecentActivity, setMemberScribdAllowed } from '../lib/storage';
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
