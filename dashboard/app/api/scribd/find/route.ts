import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { findScribdDocuments } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * POST /api/scribd/find  { query: string, page?: number }
 *
 * This asks Scribd's own search from the panel, so no search engine is involved
 * and nothing here needs a search API key.
 */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { query?: unknown; page?: unknown }
    | null;
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return NextResponse.json({ error: 'Type a few words to search for.' }, { status: 400 });
  }

  const page = Math.max(1, Math.min(Number(body?.page) || 1, 40));
  const result = await findScribdDocuments(query, page);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json(result.data);
}
