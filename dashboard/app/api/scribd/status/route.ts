import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { getScribdStatus } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** GET /api/scribd/status — the actual job state reported by the web service. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const result = await getScribdStatus();
  if (!result.ok) {
    return NextResponse.json({ error: result.error, panelOnline: false }, { status: 502 });
  }
  return NextResponse.json({ ...result.data, panelOnline: true });
}
