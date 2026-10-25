import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { readScribdFile, safeScribdName } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

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
  return new NextResponse(result.data, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(result.data.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
