import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  fetchLiveBotStatus,
  normalizePhoneNumber,
  requestLiveBotUnlink,
  requestWhitelistSync,
} from '@/lib/bot-proxy';
import {
  deleteStoredWhatsAppUser,
  getBotCommandById,
  getStoredWhatsAppUser,
  listStoredWhatsAppUsers,
  sessionBackupClaim,
  updateStoredWhatsAppUser,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store' };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });

  const { number: rawParam } = await params;
  const payload = await req.json().catch(() => null);
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));
  const user = await updateStoredWhatsAppUser(cleanNumber, {
    enabled: typeof payload?.enabled === 'boolean' ? payload.enabled : undefined,
    label: typeof payload?.label === 'string' ? payload.label : undefined,
  });
  if (!user) return NextResponse.json({ error: 'Approved number not found.' }, { status: 404 });

  await requestWhitelistSync();
  await recordActivity({ category: 'numbers', action: user.enabled ? 'Number approved' : 'Number blocked', actor: session.user.email, outcome: 'success', detail: maskedNumber(user.number) });
  return NextResponse.json({ ok: true, user });
}

async function finishUnlink(number: string, owner: string, claimKey: string) {
  const current = await getStoredWhatsAppUser(number);
  if (!current) return NextResponse.json({ ok: true, users: await listStoredWhatsAppUsers() }, { headers: privateHeaders });
  if ((current.addedBy || '').toLowerCase() !== owner || sessionBackupClaim(current).identity.key !== claimKey) {
    return NextResponse.json({ error: 'The number claim changed before unlink completed.' }, { status: 409, headers: privateHeaders });
  }
  const users = await deleteStoredWhatsAppUser(number);
  await recordActivity({ category: 'numbers', action: 'Number removed', actor: owner, outcome: 'success', detail: maskedNumber(number) });
  return NextResponse.json({ ok: true, users }, { headers: privateHeaders });
}

/** Remove approval immediately, but retain the row and stable claim until the
 * service confirms its session-scoped unlink command. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers: privateHeaders });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403, headers: privateHeaders });

  const { number: rawParam } = await params;
  const number = normalizePhoneNumber(decodeURIComponent(rawParam));
  const current = await getStoredWhatsAppUser(number);
  if (!current) return NextResponse.json({ error: 'Approved number not found.' }, { status: 404, headers: privateHeaders });

  const live = await fetchLiveBotStatus();
  if (!live.reachable || !live.accounts) {
    return NextResponse.json({ error: 'The service must be online to verify and unlink a registered session. Approval was not changed.' }, { status: 503, headers: privateHeaders });
  }
  const account = live.accounts.find((item) => item.number === number);
  const claim = sessionBackupClaim(current);
  if (!account?.sessionId) {
    const users = await deleteStoredWhatsAppUser(number);
    await recordActivity({ category: 'numbers', action: 'Number removed', actor: session.user.email, outcome: 'success', detail: maskedNumber(number) });
    return NextResponse.json({ ok: true, users }, { headers: privateHeaders });
  }
  if (account.claimToken !== claim.token) {
    return NextResponse.json({ error: 'The reported session does not match this number claim. No unlink was queued.' }, { status: 409, headers: privateHeaders });
  }

  const withdrawn = await updateStoredWhatsAppUser(number, {
    enabled: false,
    ...(current.approval === 'pending' ? { approval: 'rejected' as const } : {}),
  });
  if (!withdrawn) return NextResponse.json({ error: 'Number approval changed; refresh and try again.' }, { status: 409, headers: privateHeaders });
  await requestWhitelistSync();

  const command = await requestLiveBotUnlink(
    number,
    account.sessionId,
    (current.addedBy || '').toLowerCase(),
    claim.identity.key,
    session.user.email,
  );
  if (!command.ok || !command.requestId) {
    return NextResponse.json({ error: command.error || 'Could not queue the unlink command. Approval has been withdrawn.' }, { status: command.status || 503, headers: privateHeaders });
  }
  await recordActivity({ category: 'numbers', action: 'Number unlink queued', actor: session.user.email, outcome: 'requested', detail: maskedNumber(number) });
  return NextResponse.json({ ok: true, pending: true, requestId: command.requestId, number }, { status: 202, headers: privateHeaders });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers: privateHeaders });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403, headers: privateHeaders });

  const { number: rawParam } = await params;
  const number = normalizePhoneNumber(decodeURIComponent(rawParam));
  const requestId = req.nextUrl.searchParams.get('requestId')?.trim() || '';
  const command = requestId ? await getBotCommandById(requestId) : null;
  if (!command || command.type !== 'unlink' || (command.requestedBy || '').toLowerCase() !== session.user.email.toLowerCase() || normalizePhoneNumber(command.payload.number) !== number) {
    return NextResponse.json({ error: 'Unlink request not found.' }, { status: 404, headers: privateHeaders });
  }
  if (command.status === 'failed') return NextResponse.json({ error: command.error || 'The service could not unlink this number.' }, { status: 409, headers: privateHeaders });
  if (command.status === 'completed') {
    const sessionId = String(command.payload.sessionId || '');
    if (command.result?.unlinked !== true || command.result.number !== number || command.result.sessionId !== sessionId) {
      return NextResponse.json({ error: 'The service did not confirm the requested unlink.' }, { status: 502, headers: privateHeaders });
    }
    return finishUnlink(number, String(command.payload.owner || '').toLowerCase(), String(command.payload.claimKey || ''));
  }
  if (Date.now() > command.expiresAt) return NextResponse.json({ error: 'Unlink request expired. Approval remains withdrawn.' }, { status: 504, headers: privateHeaders });
  return NextResponse.json({ ok: true, pending: true, requestId }, { status: 202, headers: privateHeaders });
}
