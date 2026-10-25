import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { safeScribdName, signedFileUrl } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * GET /api/scribd/link?name=Book.pdf
 *
 * A fresh, short-lived link for one finished PDF. `direct: true` means the
 * browser should go to the panel itself (it is published and reachable), so the
 * bytes never pass through this app — which is what makes a 150 MB book safe on
 * a host that cuts functions off after a minute. `direct: false` falls back to
 * this app's own proxy route.
 */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const name = req.nextUrl.searchParams.get('name') || '';
  if (name && !safeScribdName(name)) {
    return NextResponse.json({ error: 'That file name is not valid.' }, { status: 400 });
  }

  const direct = await signedFileUrl(name);
  if (direct) {
    return NextResponse.json({ ok: true, url: direct, direct: true });
  }
  return NextResponse.json({
    ok: true,
    url: `/api/scribd/file${name ? `?name=${encodeURIComponent(name)}` : ''}`,
    direct: false,
  });
}
