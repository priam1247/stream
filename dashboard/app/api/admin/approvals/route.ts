import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, normalizePhoneNumber, requestWhitelistSync } from '@/lib/bot-proxy';
import { getStoredWhatsAppUser, resolvePendingWhatsAppUser, sessionBackupClaim } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const number = normalizePhoneNumber(body?.number);
  const action = body?.action;
  if (!number || (action !== 'approve' && action !== 'reject')) {
    return NextResponse.json({ error: 'Choose a valid pending request.' }, { status: 400 });
  }
  const current = await getStoredWhatsAppUser(number);
  if (!current || current.approval !== 'pending' || !current.addedBy) {
    return NextResponse.json({ error: 'This request is no longer pending.' }, { status: 409 });
  }
  const claim = sessionBackupClaim(current);
  if (action === 'approve') {
    const live = await fetchLiveBotStatus();
    const linked = live.reachable && live.accounts?.some((account) =>
      account.number === number && account.sessionId && account.claimToken === claim.token && ['connected', 'connecting', 'paused'].includes(account.state));
    if (!linked) return NextResponse.json({ error: 'The member must finish linking before approval. Check that the service is online.' }, { status: 409 });
  }
  const updated = await resolvePendingWhatsAppUser(number, current.addedBy, action === 'approve', claim.identity.key);
  if (!updated) return NextResponse.json({ error: 'The request changed or the member is blocked. Refresh and try again.' }, { status: 409 });
  await requestWhitelistSync();
  await recordActivity({ category: 'numbers', action: action === 'approve' ? 'Link approved' : 'Link rejected', actor: session.user.email, outcome: 'success', detail: maskedNumber(number) });
  return NextResponse.json({ ok: true, user: updated, sync: 'pending' });
}
