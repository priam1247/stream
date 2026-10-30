import { NextRequest, NextResponse } from 'next/server';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  getResolvedBotTarget,
  normalizePhoneNumber,
  syncNumberToLiveBot,
} from '@/lib/bot-proxy';
import {
  getStoredWhatsAppUser,
  listStoredWhatsAppUsers,
  saveStoredWhatsAppUser,
  saveMemberWhatsAppUser,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your email first.' },
      { status: 401 },
    );
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
      {
        error:
          'New WhatsApp number linking is currently paused by the administrator.',
      },
      { status: 403 },
    );
  }

  const payload = await req.json().catch(() => null);
  const number = normalizePhoneNumber(payload?.number);
  if (number.length < 8 || number.length > 15) {
    return NextResponse.json(
      { error: 'Enter a valid international WhatsApp number (8–15 digits).' },
      { status: 400 },
    );
  }

  // Prevent overwriting a WhatsApp number registered to a different member
  const existing = await getStoredWhatsAppUser(number);
  if (
    existing &&
    existing.addedBy &&
    existing.addedBy.toLowerCase() !== session.user.email.toLowerCase() &&
    !session.user.isAdmin
  ) {
    return NextResponse.json(
      { error: 'This WhatsApp number is already linked to another member account.' },
      { status: 409 },
    );
  }

  const label =
    String(payload?.label || session.user.name || 'My WhatsApp')
      .trim()
      .slice(0, 80) || 'My WhatsApp';

  if (session.user.isAdmin) {
    await saveStoredWhatsAppUser(number, label, session.user.email);
  } else if (!(await saveMemberWhatsAppUser(number, label, session.user.email))) {
    return NextResponse.json(
      { error: 'This number cannot be added. Finish or remove your pending request first, and check that the number is not already in use.' },
      { status: 409 },
    );
  }
  const saved = await getStoredWhatsAppUser(number);
  if (saved) await syncNumberToLiveBot(number, `${label} (${session.user.email})`, saved.enabled, saved.pairAllowed === true);
  await recordActivity({ category: 'numbers', action: 'Number added', actor: session.user.email, outcome: 'success', detail: maskedNumber(number) });

  const numbers = await listStoredWhatsAppUsers(session.user.email);
  return NextResponse.json({ ok: true, numbers }, { status: 201 });
}
