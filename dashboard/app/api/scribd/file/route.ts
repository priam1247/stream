import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { readScribdFile, safeScribdName } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * A big book can take a while to stream through this function. Vercel caps this
 * by plan (Hobby 60s, Pro 300s), so the value is a request, not a promise: a
 * very large PDF on a slow panel upload is better fetched from the panel
 * address directly if the plan cuts it short.
 */
export const maxDuration = 300;

/**
 * GET /api/scribd/file?name=Book.pdf
 *
 * Streams the PDF from the panel through this dashboard, so the download link
 * is on this origin: the session cookie authorises it, the panel key stays on
 * the server, and no `http://` file is ever loaded by an `https://` page.
 */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const wanted = req.nextUrl.searchParams.get('name') || '';
  if (wanted && !safeScribdName(wanted)) {
    return NextResponse.json({ error: 'That file name is not valid.' }, { status: 400 });
  }

  const result = await readScribdFile(wanted);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 502 });
  }

  const filename = result.filename.replace(/["\\]/g, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    // a phone on a slow connection must not need the whole PDF in memory
    'X-Accel-Buffering': 'no',
  };
  if (result.length) headers['Content-Length'] = result.length;
  return new NextResponse(result.body, { status: 200, headers });
}
