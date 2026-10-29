import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { resetScribdJob } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** POST /api/scribd/reset — request cancellation of running and queued jobs. */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const result = await resetScribdJob();
  if (!result.ok) {
    await recordActivity({ category: 'scribd', action: 'Cancellation request failed', actor: gate.user.email, outcome: 'failed', detail: 'The Scribd service did not accept the request.' });
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  await recordActivity({ category: 'scribd', action: 'Cancellation requested', actor: gate.user.email, outcome: 'requested', detail: '' });
  return NextResponse.json(result.data);
}
