import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Sign-out is client-side: the session token only ever lived in page memory,
 * so there is no server cookie or session record to clear.
 */
export async function POST() {
  return NextResponse.json({ ok: true });
}
