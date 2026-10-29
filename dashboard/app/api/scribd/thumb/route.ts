import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { readScribdThumbnail } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Use the service's cover proxy without exposing its token to the browser. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const result = await readScribdThumbnail(req.nextUrl.searchParams.get('url'));
  if (!result.ok) {
    const status = result.status === 400 || result.status === 404 ? result.status : 502;
    return NextResponse.json({ error: result.error }, { status });
  }
  const headers: Record<string, string> = {
    'Content-Type': result.data.type,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (result.data.length) headers['Content-Length'] = result.data.length;
  return new NextResponse(result.data.body, { status: 200, headers });
}
