import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { readPanelStatus } from '@/lib/panel-client';

export const dynamic = 'force-dynamic';

/** Report Botkeep's own server state, never infer it from the bot heartbeat. */
export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });
  return NextResponse.json(await readPanelStatus(), { headers: { 'Cache-Control': 'no-store' } });
}
