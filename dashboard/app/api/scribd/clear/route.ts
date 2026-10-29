import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { clearScribdQueue } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** The service clears history and waiting jobs, but leaves a running job alone. */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const result = await clearScribdQueue();
  if (!result.ok) {
    await recordActivity({ category: 'scribd', action: 'Queue clear request failed', actor: gate.user.email, outcome: 'failed', detail: 'The Scribd service did not accept the request.' });
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  await recordActivity({ category: 'scribd', action: 'Queue clear requested', actor: gate.user.email, outcome: 'requested', detail: '' });
  return NextResponse.json(result.data);
}
