import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus } from '@/lib/bot-proxy';
import { saveBotConnectionConfig, setFastPollWindow } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const RETIRED_FIELDS = ['botApiUrl', 'botAdminToken', 'bridgeTarget', 'upstreamHost'] as const;

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

  // Reject rather than ignore: a stale settings page must not believe it saved
  // an inbound bridge that no longer exists.
  const retired = RETIRED_FIELDS.find((field) => field in body);
  if (retired) {
    return NextResponse.json(
      { error: 'The dashboard no longer stores an inbound service URL or admin token. The service syncs outbound with BOT_SYNC_TOKEN.' },
      { status: 400 },
    );
  }

  const saved = await saveBotConnectionConfig({
    botSyncToken:
      typeof body.botSyncToken === 'string' && body.botSyncToken !== '••••••••'
        ? body.botSyncToken
        : undefined,
    botEnabledForMembers:
      typeof body.botEnabledForMembers === 'boolean'
        ? body.botEnabledForMembers
        : undefined,
  });

  await setFastPollWindow(30_000).catch(() => {});
  await recordActivity({ category: 'bot', action: typeof body.botEnabledForMembers === 'boolean'
    ? (body.botEnabledForMembers ? 'Member linking enabled' : 'Member linking paused') : 'Service sync token updated',
    actor: session.user.email, outcome: 'success', detail: '' });

  const probe = await fetchLiveBotStatus();

  return NextResponse.json({
    ok: true,
    hasBotSyncToken: Boolean(saved.botSyncToken),
    botEnabledForMembers: saved.botEnabledForMembers,
    probe,
  });
}
