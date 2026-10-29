import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { findScribdDocuments } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';
// Chromium search can take longer than an ordinary API call.
export const maxDuration = 300;

/** POST /api/scribd/find — proxy the web service's GET /api/search. */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => null)) as { query?: unknown; page?: unknown } | null;
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query || query.length > 200) {
    return NextResponse.json({ error: 'Enter a search of 1 to 200 characters.' }, { status: 400 });
  }
  const page = Math.max(1, Math.min(Math.floor(Number(body?.page) || 1), 40));
  const result = await findScribdDocuments(query, page);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 429 ? 429 : 502 });
  }
  return NextResponse.json(result.data);
}
