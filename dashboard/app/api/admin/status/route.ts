import { NextRequest, NextResponse } from 'next/server';
import {
  getAdminEmail,
  getAuthenticatedSession,
  isAdminEmail,
} from '@/lib/auth-engine';
import { fetchLiveBotStatus, getResolvedBotTarget } from '@/lib/bot-proxy';
import { JwtConfigError } from '@/lib/jwt';
import { whitelistSyncState } from '@/lib/sync-status';
import { scribdPanelConfig } from '@/lib/scribd-panel';
import {
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

  const [target, panelCfg, d1Active, users, members, liveStatus, scribdConfig] =
    await Promise.all([
      getResolvedBotTarget(),
      getPanelConnectionConfig(),
      isUsingCloudflareD1(),
      listStoredWhatsAppUsers(),
      listAllMembers(isAdminEmail),
      fetchLiveBotStatus(),
      scribdPanelConfig(),
    ]);

  const botLinked =
    liveStatus.connectionMode === 'heartbeat' ||
    Boolean(target.baseUrl && target.token);

  return NextResponse.json({
    ok: true,
    adminEmail: getAdminEmail(),
    botServerLinked: botLinked,
    connectionMode: liveStatus.connectionMode,
    botApiUrl: target.rawUrl,
    hasBotToken: Boolean(target.token),
    hasBotSyncToken: Boolean(target.syncToken),
    isInsecureHttp: target.isInsecureHttp,
    botEnabledForMembers: target.botEnabledForMembers,
    storageEngine: d1Active ? 'cloudflare-d1' : 'persistent-db',
    upstreamHost: target.hostLabel,
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
    panelConfigured: Boolean(panelCfg.panelApiKey),
    panelUrl: panelCfg.panelUrl,
    panelServerId: panelCfg.panelServerId,
    hasPanelApiKey: Boolean(panelCfg.panelApiKey),
    scribdTokenConfigured: Boolean(scribdConfig.key),
    scribdSecureTransport: scribdConfig.baseUrl.startsWith('https://'),
    latencyMs: liveStatus.latencyMs,
    users,
    members,
  });
}
