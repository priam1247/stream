import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus } from '@/lib/bot-proxy';
import { JwtConfigError } from '@/lib/jwt';
import { whitelistSyncState } from '@/lib/sync-status';
import { getBotConnectionConfig, getBotHeartbeat, listConfirmedMemberLinks, listStoredWhatsAppUsers, saveConfirmedMemberLinks, sessionBackupClaim } from '@/lib/storage';
import { changedConfirmedLinks, mergeConfirmedLinks, personalInsights } from '@/lib/member-insights-server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await getAuthenticatedSession(req);
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your email first.' },
      { status: 401 },
    );
  }

  const [target, allNumbers, live, heartbeat] = await Promise.all([
    getBotConnectionConfig(),
    listStoredWhatsAppUsers(),
    fetchLiveBotStatus(),
    getBotHeartbeat(),
  ]);
  const numbers = allNumbers.filter((item) => (item.addedBy || '').toLowerCase() === session.user.email.toLowerCase());

  // Only the bot's heartbeat can confirm a link. Store what it reported, never
  // a synthetic heartbeat; approval and liveness still require a fresh one.
  const persisted = await listConfirmedMemberLinks(numbers);
  const observed = mergeConfirmedLinks(heartbeat, live.accounts, numbers, Date.now(), persisted);
  await saveConfirmedMemberLinks(changedConfirmedLinks(observed, persisted), numbers);
  const insights = personalInsights(heartbeat, numbers, observed);

  return NextResponse.json({
    ok: true,
    adminEmail: '',
    memberAllowed: session.user.memberAllowed,
    botEnabledForMembers: target.botEnabledForMembers,
    botServerLinked: live.connectionMode === 'heartbeat',
    botReachable: live.reachable,
    botError: live.error || null,
    lastSeenSecondsAgo: live.lastSeenSecondsAgo ?? null,
    whitelistSync: whitelistSyncState(live, allNumbers, target.botEnabledForMembers),
    botConnected: live.connected,
    // Never expose the primary account's number to other members.
    botNumber: null,
    accounts: live.accounts ? live.accounts.filter((account) => {
      const owner = numbers.find((item) => item.number === account.number);
      return Boolean(owner && (!account.sessionId || (account.claimToken && account.claimToken === sessionBackupClaim(owner).token)));
    }).map(({ claimToken: _claimToken, claimCurrent: _claimCurrent, ...account }) => account) : null,
    uptimeSeconds: session.user.isAdmin ? (live.uptimeSeconds ?? null) : null,
    commandsTotal: session.user.isAdmin ? (live.commandsTotal ?? null) : null,
    downloadsSuccess: session.user.isAdmin ? (live.downloadsSuccess ?? null) : null,
    failedTotal: session.user.isAdmin ? (live.failedTotal ?? null) : null,
    ramUsedMB: session.user.isAdmin ? (live.ramUsedMB ?? null) : null,
    diskUsedMB: session.user.isAdmin ? (live.diskUsedMB ?? null) : null,
    diskBudgetMB: session.user.isAdmin ? (live.diskBudgetMB ?? null) : null,
    queueLight: session.user.isAdmin ? (live.queueLight ?? null) : null,
    queueHeavy: session.user.isAdmin ? (live.queueHeavy ?? null) : null,
    numbers,
    confirmedLinks: insights.confirmedLinks,
    personalUsage: insights.personalUsage,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
