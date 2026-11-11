import { NextRequest, NextResponse } from 'next/server';
import {
  getAdminEmail,
  getAuthenticatedSession,
  isAdminEmail,
} from '@/lib/auth-engine';
import { fetchLiveBotStatus } from '@/lib/bot-proxy';
import { JwtConfigError } from '@/lib/jwt';
import { whitelistSyncState } from '@/lib/sync-status';
import {
  getBotConnectionConfig,
  getPanelConnectionConfig,
  isUsingCloudflareD1,
  listAllMembers,
  listStoredWhatsAppUsers,
  sessionBackupClaim,
} from '@/lib/storage';

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
      { error: 'Please sign in with your administrator email.' },
      { status: 401 },
    );
  }
  if (!session.user.isAdmin) {
    return NextResponse.json(
      { error: 'Administrator privileges required.' },
      { status: 403 },
    );
  }

  const [target, panelCfg, d1Active, users, members, liveStatus] =
    await Promise.all([
      getBotConnectionConfig(),
      getPanelConnectionConfig(),
      isUsingCloudflareD1(),
      listStoredWhatsAppUsers(),
      listAllMembers(isAdminEmail),
      fetchLiveBotStatus(),
    ]);

  return NextResponse.json({
    ok: true,
    adminEmail: getAdminEmail(),
    // Linked means the service has reported at least once; nothing else can be
    // proven without its outbound heartbeat.
    botServerLinked: liveStatus.connectionMode === 'heartbeat',
    connectionMode: liveStatus.connectionMode,
    hasBotSyncToken: Boolean(target.botSyncToken),
    botEnabledForMembers: target.botEnabledForMembers,
    storageEngine: d1Active ? 'cloudflare-d1' : 'unavailable',
    botReachable: liveStatus.reachable,
    botError: liveStatus.error || null,
    connected: liveStatus.connected,
    botNumber: liveStatus.botNumber,
    accounts: liveStatus.accounts?.map(({ claimToken, ...account }) => {
      const owner = users.find((item) => item.number === account.number);
      return { ...account, claimCurrent: Boolean(owner && claimToken && claimToken === sessionBackupClaim(owner).token) };
    }) ?? null,
    lastSeenAt: liveStatus.lastSeenAt ?? null,
    lastSeenSecondsAgo: liveStatus.lastSeenSecondsAgo ?? null,
    whitelistSync: whitelistSyncState(liveStatus, users, target.botEnabledForMembers),
    sessionBackup: liveStatus.sessionBackup ?? null,
    botVersion: liveStatus.version ?? null,
    uptimeSeconds: liveStatus.uptimeSeconds ?? null,
    commandsTotal: liveStatus.commandsTotal ?? null,
    downloadsSuccess: liveStatus.downloadsSuccess ?? null,
    failedTotal: liveStatus.failedTotal ?? null,
    ramUsedMB: liveStatus.ramUsedMB ?? null,
    diskUsedMB: liveStatus.diskUsedMB ?? null,
    diskBudgetMB: liveStatus.diskBudgetMB ?? null,
    queueLight: liveStatus.queueLight ?? null,
    queueHeavy: liveStatus.queueHeavy ?? null,
    panelConfigured: Boolean(panelCfg.panelApiKey && panelCfg.panelServerId),
    panelUrl: panelCfg.panelUrl,
    panelServerId: panelCfg.panelServerId,
    hasPanelApiKey: Boolean(panelCfg.panelApiKey),
    users,
    members,
  });
}
