import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { scribdPanelConfig, testScribdConnection } from '@/lib/scribd-panel';

export const dynamic = 'force-dynamic';

/** Report the effective address and connection status without exposing a token. */
export async function GET(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  const effective = await scribdPanelConfig();
  const check = await testScribdConnection();
  return NextResponse.json({
    ok: true,
    panelUrl: effective.baseUrl,
    hasPanelKey: Boolean(effective.key),
    updatedAt: null,
    ...check,
  });
}

/** Legacy saved panel settings no longer control this service connection. */
export async function PATCH(req: NextRequest) {
  const gate = await guardScribdRequest(req, { adminOnly: true });
  if ('response' in gate) return gate.response;

  return NextResponse.json({
    error: 'The Scribd connection uses its built-in address and server-side token; saved panel settings are no longer used.',
  }, { status: 409 });
}
