import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { safeScribdName } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** The web server does not support HMAC links; keep its token off the browser. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const name = req.nextUrl.searchParams.get('name') || '';
  if (!safeScribdName(name)) {
    return NextResponse.json({ error: 'That PDF name is not valid.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, url: `/api/scribd/file?name=${encodeURIComponent(name)}`, direct: false });
}
