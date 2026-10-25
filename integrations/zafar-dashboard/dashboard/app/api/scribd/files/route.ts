import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { listScribdFiles } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** GET /api/scribd/files — the finished PDFs on the panel, newest first. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const result = await listScribdFiles();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json(result.data);
}
