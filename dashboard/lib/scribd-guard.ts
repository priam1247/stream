/**
 * One gate in front of every `/api/scribd/*` route.
 *
 * Same rules as the rest of the dashboard: a signed-in session is required.
 * Starting a download is administrator-only by default, because the panel
 * downloads with the owner's own Scribd cookies and only one job can run at a
 * time — a member starting a 400-page book would block everyone.
 *
 * To let every member download as well, call `guardScribdRequest(req)` without
 * `adminOnly` in `app/api/scribd/run/route.ts`.
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
        { error: 'Only the administrator can change Scribd panel settings or start downloads.' },
        { status: 403 },
      ),
    };
  }

  return { user: session.user };
}
