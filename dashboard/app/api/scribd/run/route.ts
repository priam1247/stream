import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { startScribdJob } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * POST /api/scribd/run  { urls?: string[], links?: string, limit?: number,
 *                         text?: boolean, jobs?: number }
 *
 * `urls` is the ticked search results; `links` is still accepted for the
 * bookmarklet and the command line. `limit: 0` means the whole document,
 * `text: true` puts each page's words into the PDF, `jobs` is the channels.
 *
 * This never refuses because something else is downloading: the documents join
 * the panel's queue and start when the current one finishes.
 */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | {
        urls?: unknown;
        links?: unknown;
        limit?: unknown;
        text?: unknown;
        jobs?: unknown;
      }
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
      { error: 'Tick at least one search result to download.' },
      { status: 400 },
    );
  }

  const limit = Math.max(0, Math.min(Number(body.limit) || 0, 5000));
  // channels: how many pages are fetched at once (the panel clamps 1..24)
  const jobs = Math.max(0, Math.min(Number(body.jobs) || 0, 24));
  const result = await startScribdJob({
    urls,
    links,
    limit,
    text: Boolean(body.text),
    jobs,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  // { ok, queued, channels, started, pending } — `started: false` means a book
  // is already downloading and these were queued behind it
  return NextResponse.json(result.data);
}
