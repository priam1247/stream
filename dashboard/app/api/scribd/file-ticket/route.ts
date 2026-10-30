import { NextRequest, NextResponse } from 'next/server';
import { guardScribdRequest } from '@/lib/scribd-guard';
import { JwtConfigError } from '@/lib/jwt';
import { safeScribdName } from '@/lib/scribd-panel';
import {
  SCRIBD_DOWNLOAD_COOKIE_PATH,
  SCRIBD_DOWNLOAD_TICKET_SECONDS,
  scribdDownloadCookieName,
  signScribdDownloadTicket,
} from '@/lib/scribd-download-ticket';

export const dynamic = 'force-dynamic';

/** Authorize a short-lived, file-scoped download without putting a session token in a URL. */
export async function POST(req: NextRequest) {
  const gate = await guardScribdRequest(req);
  if ('response' in gate) return gate.response;

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!safeScribdName(name)) {
    return NextResponse.json({ error: 'That PDF name is not valid.' }, { status: 400 });
  }

  try {
    const ticket = signScribdDownloadTicket(gate.user.email, name);
    const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    res.cookies.set(scribdDownloadCookieName(name), ticket, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: SCRIBD_DOWNLOAD_COOKIE_PATH,
      maxAge: SCRIBD_DOWNLOAD_TICKET_SECONDS,
    });
    return res;
  } catch (error) {
    if (error instanceof JwtConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
