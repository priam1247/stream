import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { resetScribdJob } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** POST /api/scribd/reset — request cancellation of running and queued jobs. */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const result = await resetScribdJob();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result.data);
}
