import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, normalizePhoneNumber, removeNumberFromLiveBot } from '@/lib/bot-proxy';
import { mergeConfirmedLinks } from '@/lib/member-insights-server';
import { cancelPendingWhatsAppUser, getBotHeartbeat, getPairCooldown, getStoredWhatsAppUser, listConfirmedMemberLinks, listStoredWhatsAppUsers, sessionBackupClaim } from '@/lib/storage';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

/** Cancel an unlinked reservation, never a completed WhatsApp link. */
export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers });
  const body = await req.json().catch(() => null);
  const number = normalizePhoneNumber(body?.number);
  const current = await getStoredWhatsAppUser(number);
  if (!current || (current.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: 'Number not found on your account.' }, { status: 404, headers });
  }
  if (current.approval !== 'pending') return NextResponse.json({ error: 'Only an unlinked pending request can be removed.' }, { status: 409, headers });
  const now = Date.now();
  if (await getPairCooldown(number) > now) return NextResponse.json({ error: 'Wait for the resend timer before changing numbers.' }, { status: 409, headers });
  const [live, heartbeat, persisted] = await Promise.all([fetchLiveBotStatus(), getBotHeartbeat(), listConfirmedMemberLinks([current])]);
  if (!live.reachable || !live.accounts) return NextResponse.json({ error: 'The WhatsApp service is offline. Try again when it reconnects.' }, { status: 503, headers });
  const account = live.accounts.find((item) => item.number === number);
  const linked = mergeConfirmedLinks(heartbeat, live.accounts, [current], now, persisted).length > 0;
  if (linked) return NextResponse.json({ error: 'This number is linked. Use Unlink in settings instead.' }, { status: 409, headers });
  // An awaiting link may have registered since the last heartbeat. Only a
  // terminal attempt (or no attempt) is safe to discard.
  if (account && account.state !== 'expired' && account.state !== 'logged_out') {
    return NextResponse.json({ error: 'The linking attempt is still active. Try again after it expires.' }, { status: 409, headers });
  }
  const claim = sessionBackupClaim(current).identity;
  if (!(await cancelPendingWhatsAppUser(number, session.user.email, claim.key))) {
    return NextResponse.json({ error: 'The request changed or another code was requested. Refresh and try again.' }, { status: 409, headers });
  }
  await removeNumberFromLiveBot(number);
  await recordActivity({ category: 'numbers', action: 'Pending link removed', actor: session.user.email, outcome: 'success', detail: maskedNumber(number) });
  return NextResponse.json({ ok: true, numbers: await listStoredWhatsAppUsers(session.user.email) }, { headers });
}
