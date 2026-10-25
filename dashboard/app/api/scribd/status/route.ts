import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { getScribdHealth, getScribdStatus } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/**
 * GET /api/scribd/status
 *
 * The panel's job, plus whether the panel itself is answering. The health call
 * is what lets the page say "panel offline" or "panel locked" instead of just
 * showing an empty progress bar.
 */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const [status, health] = await Promise.all([getScribdStatus(), getScribdHealth()]);

  if (!status.ok) {
    return NextResponse.json(
      {
        error: status.error,
        panelOnline: health.ok,
        health: health.ok ? health.data : null,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ...status.data,
    panelOnline: true,
    health: health.ok ? health.data : null,
  });
}
