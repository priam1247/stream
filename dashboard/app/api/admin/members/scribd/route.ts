import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession, isAdminEmail } from '@/lib/auth-engine';
import { recordActivity } from '@/lib/activity';
import { listAllMembers, setMemberScribdAllowed } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** Grant or revoke access to the shared Scribd library; never grants job controls. */
export async function PATCH(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof body?.allowed !== 'boolean') {
    return NextResponse.json({ error: 'A valid member email and access choice are required.' }, { status: 400 });
  }
  if (isAdminEmail(email)) {
    return NextResponse.json({ error: 'Owner access cannot be changed here.' }, { status: 400 });
  }
  const members = await listAllMembers(isAdminEmail);
  if (!members.some((member) => member.email.toLowerCase() === email)) {
    return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
  }

  await setMemberScribdAllowed(email, body.allowed);
  await recordActivity({
    category: 'members',
    action: body.allowed ? 'Scribd access granted' : 'Scribd access revoked',
    actor: session.user.email,
    outcome: 'success',
    detail: email,
  });
  return NextResponse.json({ ok: true, members: await listAllMembers(isAdminEmail) });
}
