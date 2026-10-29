import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { startScribdJob } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** POST /api/scribd/run — submit selected document IDs to /api/download. */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => null)) as
    | { docs?: unknown; urls?: unknown; links?: unknown }
    | null;
  if (!body || typeof body !== 'object' ||
      (body.docs !== undefined && !Array.isArray(body.docs)) ||
      (body.urls !== undefined && !Array.isArray(body.urls))) {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const docs = Array.isArray(body.docs) ? body.docs : [];
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  const links = typeof body.links === 'string' ? body.links : '';
  const result = await startScribdJob({ docs, urls, links });
  if (!result.ok) {
    await recordActivity({ category: 'scribd', action: 'Download request failed', actor: gate.user.email, outcome: 'failed', detail: 'The Scribd service did not accept the request.' });
    return NextResponse.json({ error: result.error }, { status: result.status === 400 ? 400 : 502 });
  }
  await recordActivity({ category: 'scribd', action: 'Download submitted', actor: gate.user.email, outcome: 'requested', detail: `${result.data.acceptedIds.length} document(s) reported accepted.` });
  return NextResponse.json(result.data);
}
