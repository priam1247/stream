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

/** Apply the same current-account and grant checks to sessions and file tickets. */
export function gateScribdUser(user: AuthUser | null, options: { adminOnly?: boolean } = {}): ScribdGate {
  if (!user) {
    return {
      response: NextResponse.json(
        { error: 'Please sign in before using the Scribd panel.' },
        { status: 401 },
      ),
    };
  }

  if (options.adminOnly && !user.isAdmin) {
    return {
      response: NextResponse.json(
        { error: 'This Scribd action is restricted to administrators.' },
        { status: 403 },
      ),
    };
  }

  if (!user.isAdmin && (!user.memberAllowed || !user.scribdAllowed)) {
    return {
      response: NextResponse.json(
        { error: 'Scribd access has not been granted for this account.' },
        { status: 403 },
      ),
    };
  }

  return { user };
}

export async function guardScribdRequest(
  req: NextRequest,
  options: { adminOnly?: boolean } = {},
): Promise<ScribdGate> {
  try {
    const session = await getAuthenticatedSession(req);
    return gateScribdUser(session?.user || null, options);
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return { response: NextResponse.json({ error: err.message }, { status: 503 }) };
    }
    throw err;
  }
}
