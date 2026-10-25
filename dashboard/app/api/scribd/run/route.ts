import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { startScribdJob } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * POST /api/scribd/run  { urls?: string[], links?: string, limit?: number, text?: boolean }
 *
 * `links` is the paste box (anything that is not a Scribd link is dropped by
 * the panel itself); `urls` is the ticked search results. `limit: 0` means the
 * whole document, `text: true` puts each page's words into the PDF.
 */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { urls?: unknown; links?: unknown; limit?: unknown; text?: unknown }
    | null;
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const links = typeof body.links === 'string' ? body.links : '';
  if (!urls.length && !links.trim()) {
    return NextResponse.json(
      { error: 'Paste at least one Scribd document link, or tick a search result.' },
      { status: 400 },
    );
  }

  const limit = Math.max(0, Math.min(Number(body.limit) || 0, 5000));
  const result = await startScribdJob({ urls, links, limit, text: Boolean(body.text) });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 409 ? 409 : 502 });
  }
  return NextResponse.json(result.data);
}
