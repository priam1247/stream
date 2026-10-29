import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { maskedNumber, recordActivity } from '@/lib/activity';
import { normalizePhoneNumber, syncNumberToLiveBot } from '@/lib/bot-proxy';
import { getStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ number: string }> }) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });

  const { number } = await params;
  const item = await getStoredWhatsAppUser(normalizePhoneNumber(number));
  if (!item) return NextResponse.json({ error: 'Number not found.' }, { status: 404 });

  const result = await syncNumberToLiveBot(item.number, item.label || 'Approved number', item.enabled);
  await recordActivity({ category: 'numbers', action: 'Number sync requested', actor: session.user.email,
    outcome: 'requested', detail: maskedNumber(item.number) });
  return NextResponse.json({ ok: true, result, message: result === 'accepted'
    ? 'The service accepted the sync request. Check the latest status for confirmation.'
    : 'Saved list is waiting for the service to check in. Sync is not yet confirmed.' });
}
