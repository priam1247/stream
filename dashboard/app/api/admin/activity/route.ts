import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { isUsingCloudflareD1, listRecentActivity } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });

  const [events, durable] = await Promise.all([listRecentActivity(100), isUsingCloudflareD1()]);
  return NextResponse.json({ ok: true, events, storage: durable ? 'cloudflare-d1' : 'local' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
