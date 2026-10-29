import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  checkQueuedPairCommand,
  normalizePhoneNumber,
  requestLiveBotPairingCode,
} from '@/lib/bot-proxy';
import { getStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
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

  const requestId = req.nextUrl.searchParams.get('requestId')?.trim() || '';
  if (!requestId) {
    return NextResponse.json({ error: 'Missing requestId.' }, { status: 400 });
  }

  const res = await checkQueuedPairCommand(requestId);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.status });
  }
  if (res.pending) {
    return NextResponse.json({ ok: true, pending: true, requestId }, { status: 202 });
  }

  return NextResponse.json({
    ok: true,
    code: res.code,
    expiresInSeconds: res.expiresInSeconds || 60,
    issuedAt: res.issuedAt || Date.now(),
  });
}

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

  const payload = await req.json().catch(() => null);
  const number = normalizePhoneNumber(payload?.number);
  if (number.length < 8 || number.length > 15) {
    return NextResponse.json({ error: 'Enter a valid international WhatsApp number.' }, { status: 400 });
  }
  const stored = await getStoredWhatsAppUser(number);
  if (!stored?.enabled) {
    return NextResponse.json({ error: 'Approve and enable this number before requesting a pairing code.' }, { status: 403 });
  }

  const requestedAt = Date.now();
  const result = await requestLiveBotPairingCode(
    number,
    stored?.label || 'Admin Linked Number',
    session.user.email,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await recordActivity({ category: 'numbers', action: 'Pairing code requested', actor: session.user.email, outcome: 'requested', detail: maskedNumber(number) });

  if (result.pending && result.requestId) {
    return NextResponse.json(
      {
        ok: true,
        pending: true,
        requestId: result.requestId,
        number,
      },
      { status: 202 },
    );
  }

  return NextResponse.json({
    ok: true,
    code: result.code,
    expiresInSeconds: result.expiresInSeconds || 60,
    number,
    issuedAt: result.issuedAt ?? requestedAt,
  });
}
