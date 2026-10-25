import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { listScribdFiles, scribdPublicUrl } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** GET /api/scribd/files — the finished PDFs on the panel, newest first. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const result = await listScribdFiles();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  // `publicBase` is set only when the panel is published over HTTPS itself: the
  // page then links straight at it, so a huge PDF skips this app's functions.
  return NextResponse.json({ ...result.data, publicBase: scribdPublicUrl() });
}
