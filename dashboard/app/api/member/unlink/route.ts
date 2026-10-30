import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, normalizePhoneNumber, removeNumberFromLiveBot, requestLiveBotUnlink } from '@/lib/bot-proxy';
import { deleteWhatsAppUserIfOwned, getBotCommandById, getStoredWhatsAppUser, listStoredWhatsAppUsers, sessionBackupClaim } from '@/lib/storage';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

async function finishUnlink(number: string, owner: string, expectedClaim: string) {
  const existing = await getStoredWhatsAppUser(number);
  // A prior poll may already have finished. Never delete a new owner's number.
  if (!existing) return NextResponse.json({ ok: true, numbers: await listStoredWhatsAppUsers(owner) }, { headers });
  if ((existing.addedBy || '').toLowerCase() !== owner.toLowerCase() ||
      sessionBackupClaim(existing).identity.key !== expectedClaim || !(await deleteWhatsAppUserIfOwned(number, owner, expectedClaim))) {
    return NextResponse.json({ error: 'This number no longer belongs to your account.' }, { status: 409, headers });
  }
  await removeNumberFromLiveBot(number);
  await recordActivity({ category: 'numbers', action: 'Number unlinked', actor: owner, outcome: 'success', detail: maskedNumber(number) });
  return NextResponse.json({ ok: true, numbers: await listStoredWhatsAppUsers(owner) }, { headers });
}

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers });
  const payload = await req.json().catch(() => null);
  const number = normalizePhoneNumber(payload?.number);
  const existing = await getStoredWhatsAppUser(number);
  if (!existing || (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: 'Number not found on your account.' }, { status: 404, headers });
  }

  const live = await fetchLiveBotStatus();
  if (!live.reachable || !live.accounts) {
    return NextResponse.json({ error: 'The WhatsApp service is offline or needs an update. Try again when it is available.' }, { status: 503, headers });
  }
  const account = live.accounts.find((item) => item.number === number);
  const claim = sessionBackupClaim(existing);
  if (!account?.sessionId || account.claimToken !== claim.token) {
    return NextResponse.json({ error: 'This session cannot be unlinked here. Update the service or use WhatsApp linked devices.' }, { status: 409, headers });
  }
  const claimKey = claim.identity.key;
  const result = await requestLiveBotUnlink(number, account.sessionId, session.user.email, claimKey);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers });
  if (result.pending && result.requestId) {
    return NextResponse.json({ ok: true, pending: true, requestId: result.requestId, number }, { status: 202, headers });
  }
  return finishUnlink(number, session.user.email, claimKey);
}

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers });
  const id = req.nextUrl.searchParams.get('requestId')?.trim() || '';
  const cmd = id ? await getBotCommandById(id) : null;
  if (!cmd || cmd.type !== 'unlink' || (cmd.requestedBy || '').toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: 'Unlink request not found.' }, { status: 404, headers });
  }
  const number = normalizePhoneNumber(cmd.payload.number);
  const sessionId = String(cmd.payload.sessionId || '');
  if (cmd.status === 'failed') return NextResponse.json({ error: cmd.error || 'Could not unlink this number.' }, { status: 409, headers });
  if (cmd.status === 'completed') {
    if (cmd.result?.unlinked !== true || cmd.result.number !== number || cmd.result.sessionId !== sessionId) {
      return NextResponse.json({ error: 'The service did not confirm the unlink.' }, { status: 502, headers });
    }
    const claimKey = typeof cmd.payload.claimKey === 'string' ? cmd.payload.claimKey : '';
    if (!claimKey) return NextResponse.json({ error: 'This unlink request is outdated. Please try again.' }, { status: 409, headers });
    return finishUnlink(number, session.user.email, claimKey);
  }
  if (Date.now() > cmd.expiresAt) return NextResponse.json({ error: 'Unlink request expired. Please try again.' }, { status: 504, headers });
  return NextResponse.json({ ok: true, pending: true, requestId: id }, { status: 202, headers });
}
