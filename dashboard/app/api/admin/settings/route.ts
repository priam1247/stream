import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, parseAndValidateBotUrl } from '@/lib/bot-proxy';
import { getFailoverStatus, saveBotConnectionConfig, setFastPollWindow } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json(
      { error: 'Administrator privileges required.' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const failover = await getFailoverStatus();
  if (failover.enabled && typeof body.botApiUrl === 'string' && body.botApiUrl.trim()) {
    return NextResponse.json({ error: 'Failover uses outbound sync only; leave the direct URL blank.' }, { status: 400 });
  }
  if (typeof body.botApiUrl === 'string' && body.botApiUrl.trim()) {
    const parsed = parseAndValidateBotUrl(body.botApiUrl);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
  }

  let saved: Awaited<ReturnType<typeof saveBotConnectionConfig>>;
  try {
    saved = await saveBotConnectionConfig({
      botApiUrl: !failover.enabled && typeof body.botApiUrl === 'string' ? body.botApiUrl : undefined,
      botAdminToken:
        !failover.enabled && typeof body.botAdminToken === 'string' && body.botAdminToken !== '••••••••'
          ? body.botAdminToken
          : undefined,
      botSyncToken:
        typeof body.botSyncToken === 'string' && body.botSyncToken !== '••••••••'
          ? body.botSyncToken
          : undefined,
      botXsSyncToken:
        typeof body.botXsSyncToken === 'string' && body.botXsSyncToken !== '••••••••'
          ? body.botXsSyncToken
          : undefined,
      botBotkeepSyncToken:
        typeof body.botBotkeepSyncToken === 'string' && body.botBotkeepSyncToken !== '••••••••'
          ? body.botBotkeepSyncToken
          : undefined,
      botEnabledForMembers:
        typeof body.botEnabledForMembers === 'boolean'
          ? body.botEnabledForMembers
          : undefined,
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'INVALID_BOT_CREDENTIALS') {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  await setFastPollWindow(30_000).catch(() => {});
  await recordActivity({ category: 'bot', action: typeof body.botEnabledForMembers === 'boolean'
    ? (body.botEnabledForMembers ? 'Member linking enabled' : 'Member linking paused') : 'Service connection updated',
    actor: session.user.email, outcome: 'success', detail: '' });

  const parsed = parseAndValidateBotUrl(saved.botApiUrl);
  // Setting up role tokens must not probe a retained single-host address before
  // either coordinated host has checked in.
  const changingHostCredentials = typeof body.botXsSyncToken === 'string' || typeof body.botBotkeepSyncToken === 'string';
  const probe = changingHostCredentials ? null : !failover.enabled && parsed.baseUrl
    ? await fetchLiveBotStatus({
        baseUrl: parsed.baseUrl,
        token: saved.botAdminToken,
      })
    : await fetchLiveBotStatus();

  return NextResponse.json({
    ok: true,
    botApiUrl: failover.enabled ? '' : saved.botApiUrl,
    hasBotToken: !failover.enabled && Boolean(saved.botAdminToken),
    hasBotSyncToken: Boolean(saved.botSyncToken),
    hasXsSyncToken: Boolean(saved.botXsSyncToken),
    hasBotkeepSyncToken: Boolean(saved.botBotkeepSyncToken),
    botEnabledForMembers: saved.botEnabledForMembers,
    probe,
  });
}
