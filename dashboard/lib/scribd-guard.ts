/**
 * One gate in front of every `/api/scribd/*` route.
 *
 * A signed-in owner can use all routes. Members may read the shared queue and
 * files only after an explicit owner grant, and lose access while blocked.
 * Starting, cancelling and clearing jobs remain administrator-only because
 * the web service uses a single shared queue and the owner's Scribd cookies.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { JwtConfigError } from '@/lib/jwt';
import type { AuthUser } from '@/lib/types';

export type ScribdGate = { response: NextResponse } | { user: AuthUser };

export async function guardScribdRequest(
  req: NextRequest,
  options: { adminOnly?: boolean } = {},
): Promise<ScribdGate> {
  let session: Awaited<ReturnType<typeof getAuthenticatedSession>>;
  try {
    session = await getAuthenticatedSession(req);
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return {
        response: NextResponse.json({ error: err.message }, { status: 503 }),
      };
    }
    throw err;
  }

  if (!session) {
    return {
      response: NextResponse.json(
        { error: 'Please sign in before using the Scribd panel.' },
        { status: 401 },
      ),
    };
  }

  if (options.adminOnly && !session.user.isAdmin) {
    return {
      response: NextResponse.json(
        { error: 'This Scribd action is restricted to administrators.' },
        { status: 403 },
      ),
    };
  }

  if (!session.user.isAdmin && (!session.user.memberAllowed || !session.user.scribdAllowed)) {
    return {
      response: NextResponse.json(
        { error: 'Scribd access has not been granted for this account.' },
        { status: 403 },
      ),
    };
  }

  return { user: session.user };
}
