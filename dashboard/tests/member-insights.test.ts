// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { memberAnalytics } from '../lib/member-analytics';
import { mergeConfirmedLinks, personalInsights, readServiceMemberUsage } from '../lib/member-insights-server';
import { sessionBackupClaim } from '../lib/storage';
import type { ApprovedUser, BotHeartbeatRecord, WhatsAppAccountStatus } from '../lib/types';

const now = Date.UTC(2026, 6, 15, 12);
const user = (number: string, owner: string, claimId: string): ApprovedUser => ({ number, addedBy: owner, claimId, addedAt: '2026-06-01T00:00:00.000Z', enabled: false, approval: 'pending', label: owner });
const alice = user('265991111111', 'alice@example.com', 'alice-claim');
const bob = user('265992222222', 'bob@example.com', 'bob-claim');
const aliceToken = sessionBackupClaim(alice).token;
const bobToken = sessionBackupClaim(bob).token;
const account = (overrides: Partial<WhatsAppAccountStatus> = {}): WhatsAppAccountStatus => ({
  number: alice.number, sessionId: 'a'.repeat(24), claimToken: aliceToken, state: 'paused', linkedAt: now - 60_000, ...overrides,
});
const heartbeat = (overrides: Partial<BotHeartbeatRecord> = {}): BotHeartbeatRecord => ({ lastSeenAt: now, connected: false, botNumber: null, ...overrides });

describe('claim-scoped link evidence', () => {
  it('does not treat approval, a pending code, a primary socket or another claim as a completed link', () => {
    for (const candidate of [account({ state: 'awaiting_link' }), account({ state: 'expired' }),
      account({ state: 'logged_out' }), account({ sessionId: undefined }), account({ claimToken: bobToken })]) {
      expect(mergeConfirmedLinks(null, [candidate], [alice], now)).toEqual([]);
    }
  });
  it('remembers a confirmed link through outages or logout, without transferring it to a new owner', () => {
    const confirmed = mergeConfirmedLinks(null, [account()], [alice], now);
    expect(confirmed).toHaveLength(1);
    const next = heartbeat({ confirmedLinks: confirmed, accounts: [account({ state: 'logged_out' })] });
    expect(personalInsights(next, [alice]).confirmedLinks).toEqual([{ number: alice.number, linkedAt: now - 60_000 }]);
    expect(personalInsights(next, [user(alice.number, 'other@example.com', 'other-claim')]).confirmedLinks).toEqual([]);
    expect(personalInsights(next, [user(alice.number, 'alice@example.com', 'new-claim')]).confirmedLinks).toEqual([]);
  });
  it('backfills evidence from a pre-upgrade signed heartbeat but not from unlinked records', () => {
    expect(personalInsights(heartbeat({ accounts: [account()] }), [alice]).confirmedLinks).toHaveLength(1);
    expect(personalInsights(heartbeat({ accounts: [account({ state: 'awaiting_link' })] }), [alice]).confirmedLinks).toEqual([]);
  });
});

describe('private per-account command analytics', () => {
  it('accepts only current claims and bounded, valid dates and counts', () => {
    const sample = readServiceMemberUsage({ startedAt: now - 30 * 86_400_000, sessions: [
      { number: alice.number, sessionId: 'a'.repeat(24), claimToken: aliceToken, lastAt: now, lastCommand: 'song', days: [
        { date: '2026-07-15', commands: { song: 4, paper: 2, 'song private words': 30, negative: -1, huge: 1_000_001 } },
        { date: '2026-06-01', commands: { ping: 10 } },
        { date: '2026-07-35', commands: { ping: 10 } },
      ] },
      { number: bob.number, sessionId: 'b'.repeat(24), claimToken: bobToken, days: [{ date: '2026-07-15', commands: { movie: 77 } }] },
      { number: alice.number, sessionId: 'c'.repeat(24), claimToken: bobToken, days: [{ date: '2026-07-15', commands: { movie: 999 } }] },
    ] }, [alice, bob], now)!;
    expect(sample.sessions).toHaveLength(2);
    const result = personalInsights(heartbeat({ memberUsage: sample }), [alice]);
    // personalInsights uses the real clock when pruning; inspect the normalized
    // sample separately, and use a current sample to prove response isolation.
    expect(sample.sessions[0].days).toEqual([{ date: '2026-07-15', commands: { song: 4, paper: 2 } }]);
    expect(JSON.stringify(result)).not.toContain(bob.number);
    expect(JSON.stringify(result)).not.toContain(aliceToken);
    expect(JSON.stringify(result)).not.toContain(bobToken);
    expect(JSON.stringify(result)).not.toContain('999');
  });
  it('returns only the authenticated member’s aggregate across their own generations', () => {
    const today = new Date().toISOString().slice(0, 10);
    const sample = readServiceMemberUsage({ startedAt: Date.now() - 86_400_000, sessions: [
      { number: alice.number, sessionId: 'a'.repeat(24), claimToken: aliceToken, days: [{ date: today, commands: { ping: 2 } }] },
      { number: alice.number, sessionId: 'c'.repeat(24), claimToken: aliceToken, days: [{ date: today, commands: { ping: 3, song: 1 } }] },
      { number: bob.number, sessionId: 'b'.repeat(24), claimToken: bobToken, days: [{ date: today, commands: { song: 77 } }] },
    ] }, [alice, bob])!;
    const result = personalInsights(heartbeat({ memberUsage: sample }), [alice]);
    expect(result.personalUsage).toHaveLength(1);
    expect(result.personalUsage?.[0].number).toBe(alice.number);
    expect(result.personalUsage?.[0].days).toEqual([{ date: today, commands: { ping: 5, song: 1 } }]);
    expect(JSON.stringify(result)).not.toContain(bob.number);
    expect(JSON.stringify(result)).not.toContain(bobToken);
  });
  it('does not expose malformed persisted sampling timestamps to the portal', () => {
    const sample = readServiceMemberUsage({ startedAt: Date.now() - 1000, sessions: [] }, [alice])!;
    expect(personalInsights(heartbeat({ memberUsage: { ...sample, updatedAt: 9_000_000_000_000_000 } }), [alice]).personalUsage).toBeNull();
  });
  it('distinguishes unmeasured days from zero activity and computes the real command mix', () => {
    const analytics = memberAnalytics({ number: alice.number, trackedSince: Date.UTC(2026, 6, 13, 14), updatedAt: Date.UTC(2026, 6, 14, 20), days: [
      { date: '2026-07-13', commands: { song: 3, paper: 2 } }, { date: '2026-07-14', commands: { menu: 1 } },
    ] }, now);
    expect(analytics.measuredDays).toBe(2);
    expect(analytics.total).toBe(6);
    expect(analytics.activeDays).toBe(2);
    expect(analytics.days.at(-1)?.total).toBeNull();
    expect(analytics.previousTotal).toBeNull();
    expect(analytics.categoryCounts).toMatchObject({ media: 3, vault: 2, general: 1 });
    expect(analytics.top[0]).toEqual(['song', 3]);
  });
});
