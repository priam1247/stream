import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  fetchLiveBotStatus,
  normalizePhoneNumber,
  requestWhitelistSync,
} from '@/lib/bot-proxy';
import {
  deleteWhatsAppUserIfOwned,
  getStoredWhatsAppUser,
  listStoredWhatsAppUsers,
  updateStoredWhatsAppUser,
  sessionBackupClaim,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (!session.user.memberAllowed) {
    return NextResponse.json(
      {
        error: 'Your account access has been restricted.',
      },
      { status: 403 },
    );
  }

  const { number: rawParam } = await params;
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));
  const existing = await getStoredWhatsAppUser(cleanNumber);

  if (
    !existing ||
    (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json({ error: 'Number not found on your account.' }, { status: 404 });
  }

  const payload = await req.json().catch(() => null);
  const updated = await updateStoredWhatsAppUser(cleanNumber, {
    enabled: typeof payload?.enabled === 'boolean' ? payload.enabled : undefined,
    label: typeof payload?.label === 'string' ? payload.label : undefined,
  });

  if (updated) {
    await requestWhitelistSync();
  }

  if (updated) await recordActivity({ category: 'numbers', action: updated.enabled ? 'Number enabled' : 'Number paused', actor: session.user.email, outcome: 'success', detail: maskedNumber(cleanNumber) });
  const numbers = await listStoredWhatsAppUsers(session.user.email);
  return NextResponse.json({ ok: true, numbers });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const { number: rawParam } = await params;
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));
  const existing = await getStoredWhatsAppUser(cleanNumber);

  if (
    !existing ||
    (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json({ error: 'Number not found on your account.' }, { status: 404 });
  }

  const live = await fetchLiveBotStatus();
  if (!live.reachable || !live.accounts) {
    return NextResponse.json({ error: 'The WhatsApp service must be reachable before removing this number.' }, { status: 503 });
  }
  if (live.accounts.some((account) => account.number === cleanNumber && account.sessionId)) {
    return NextResponse.json({ error: 'This number has a service session. Use Unlink so its session is closed before removing approval.' }, { status: 409 });
  }

  if (!(await deleteWhatsAppUserIfOwned(cleanNumber, session.user.email, sessionBackupClaim(existing).identity.key))) {
    return NextResponse.json({ error: 'Number no longer belongs to your account.' }, { status: 409 });
  }
  await requestWhitelistSync();
  await recordActivity({ category: 'numbers', action: 'Number removed', actor: session.user.email, outcome: 'success', detail: maskedNumber(cleanNumber) });

  const numbers = await listStoredWhatsAppUsers(session.user.email);
  return NextResponse.json({ ok: true, numbers });
}
