import { NextRequest, NextResponse } from 'next/server';
import { getVerifiedAuthUser } from '@/lib/auth-engine';
import { gateScribdUser, guardScribdRequest } from '@/lib/scribd-guard';
import { JwtConfigError } from '@/lib/jwt';
import { readScribdFile, safeScribdName } from '@/lib/scribd-panel';
import {
  SCRIBD_DOWNLOAD_COOKIE_PATH,
  scribdDownloadCookieName,
  verifyScribdDownloadTicket,
} from '@/lib/scribd-download-ticket';

export const dynamic = 'force-dynamic';
// Hosting plans may impose a lower limit despite this requested duration.
export const maxDuration = 300;

/** Stream a local PDF through the dashboard; the upstream token stays private. */
export async function GET(req: NextRequest) {
  const wanted = req.nextUrl.searchParams.get('name') || '';
  const gate = await guardScribdRequest(req);
  let usedTicket = false;
  if ('response' in gate) {
    // An explicit bearer session remains the normal API path. Browsers cannot
    // attach that header to a download, so allow a narrowly scoped ticket too.
    if (gate.response.status !== 401 || !safeScribdName(wanted)) return gate.response;
    const ticket = req.cookies.get(scribdDownloadCookieName(wanted))?.value || '';
    if (!ticket) return gate.response;
    try {
      const email = verifyScribdDownloadTicket(ticket, wanted);
      if (!email) return gate.response;
      const ticketGate = gateScribdUser(await getVerifiedAuthUser(email));
      if ('response' in ticketGate) return ticketGate.response;
      usedTicket = true;
    } catch (error) {
      if (error instanceof JwtConfigError) return NextResponse.json({ error: error.message }, { status: 503 });
      throw error;
    }
  }

  if (!safeScribdName(wanted)) {
    return NextResponse.json({ error: 'That PDF name is not valid.' }, { status: 400 });
  }
  const result = await readScribdFile(wanted);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 502 });
  }
  const filename = result.data.filename;
  const asciiName = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  };
  if (result.data.length) headers['Content-Length'] = result.data.length;
  const response = new NextResponse(result.data.body, { status: 200, headers });
  if (usedTicket) {
    response.cookies.set(scribdDownloadCookieName(wanted), '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: SCRIBD_DOWNLOAD_COOKIE_PATH,
      maxAge: 0,
    });
  }
  return response;
}
