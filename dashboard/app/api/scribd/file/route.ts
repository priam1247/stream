import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { readScribdFile, safeScribdName } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';
// Hosting plans may impose a lower limit despite this requested duration.
export const maxDuration = 300;

/** Stream a local PDF through the dashboard; the upstream token stays private. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const wanted = req.nextUrl.searchParams.get('name') || '';
  if (!safeScribdName(wanted)) {
    return NextResponse.json({ error: 'That PDF name is not valid.' }, { status: 400 });
  }
  const result = await readScribdFile(wanted);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 502 });
  }
  const filename = result.data.filename;
  const asciiName = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  };
  if (result.data.length) headers['Content-Length'] = result.data.length;
  return new NextResponse(result.data.body, { status: 200, headers });
}
