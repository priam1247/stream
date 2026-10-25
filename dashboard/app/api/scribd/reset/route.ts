import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { resetScribdJob } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * POST /api/scribd/reset
 *
 * Stops a job the panel still believes is running. The panel already steps over
 * a job that has not moved for seven minutes, so this is the "now" button — and
 * the way out of a stuck download that would otherwise block every new one.
 * Administrator only, like starting a download.
 */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const result = await resetScribdJob();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json(result.data);
}
