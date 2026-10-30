import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import { AuthServiceError, verifyUserEmailCode } from '@/lib/auth-engine';
import { clearSessionCookie } from '@/lib/jwt';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const result = await verifyUserEmailCode({
      email: String(body.email || ''),
      code: String(body.code || ''),
    });

    if (result.user) {
      await recordActivity({ category: 'account', action: 'Email verified', actor: result.user.email, outcome: 'success', detail: '' });
    }
    const res = NextResponse.json({
      ok: true,
      message: result.message,
      token: result.sessionToken || null,
      user: result.user || null,
    });

    // Expire any cookie left over from the old persistent-session design.
    return result.sessionToken ? clearSessionCookie(res) : res;
  } catch (err) {
    if (err instanceof AuthServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Verification failed. Please check your code and try again.' },
      { status: 500 },
    );
  }
}
