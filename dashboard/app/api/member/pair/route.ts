import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  checkQueuedPairCommand,
  getResolvedBotTarget,
  normalizePhoneNumber,
  requestLiveBotPairingCode,
} from '@/lib/bot-proxy';
import { getStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store' };

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  if (!session.user.memberAllowed) {
    return NextResponse.json({ error: 'Your account access has been restricted.' }, { status: 403 });
  }

  const requestId = req.nextUrl.searchParams.get('requestId')?.trim() || '';
  if (!requestId) {
    return NextResponse.json({ error: 'Missing requestId.' }, { status: 400 });
  }

  const res = await checkQueuedPairCommand(requestId, session.user.email);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.status });
  }
  if (res.pending) {
    return NextResponse.json({ ok: true, pending: true, requestId }, { status: 202, headers: privateHeaders });
  }

  return NextResponse.json({
    ok: true,
    code: res.code,
    expiresInSeconds: res.expiresInSeconds || 60,
    issuedAt: res.issuedAt || Date.now(),
  }, { headers: privateHeaders });
}

export async function POST(req: NextRequest) {
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

  const target = await getResolvedBotTarget();
  if (!target.botEnabledForMembers && !session.user.isAdmin) {
    return NextResponse.json(
      { error: 'WhatsApp linking is temporarily paused by the administrator.' },
      { status: 403 },
    );
  }

  const payload = await req.json().catch(() => null);
  const number = normalizePhoneNumber(payload?.number);
  const existing = await getStoredWhatsAppUser(number);

  if (
    !existing ||
    (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: 'Add and allow this number on your account before requesting a code.' },
      { status: 403 },
    );
  }

  if (!existing.enabled) {
    return NextResponse.json(
      { error: 'Enable this number first before requesting a WhatsApp linking code.' },
      { status: 403 },
    );
  }

  const requestedAt = Date.now();
  const result = await requestLiveBotPairingCode(
    number,
    `${existing.label || session.user.name} (${session.user.email})`,
    session.user.email,
    true,
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
      { status: 202, headers: privateHeaders },
    );
  }

  return NextResponse.json({
    ok: true,
    code: result.code,
    expiresInSeconds: result.expiresInSeconds || 60,
    number,
    issuedAt: result.issuedAt ?? requestedAt,
  }, { headers: privateHeaders });
}
