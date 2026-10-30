import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { MEMBER_COMMANDS } from '@/lib/bot-data';
import { recordActivity } from '@/lib/activity';
import { getBotHeartbeat, getMemberCommandPolicy, setMemberCommandDisabled } from '@/lib/storage';

export const dynamic = 'force-dynamic';
const commandNames = new Set(MEMBER_COMMANDS.map((command) => command.name));

async function snapshot() {
  const [policy, heartbeat] = await Promise.all([getMemberCommandPolicy(), getBotHeartbeat()]);
  const fresh = heartbeat && Date.now() - heartbeat.lastSeenAt <= 60_000;
  return { ...policy, sync: fresh && heartbeat.commandPolicyVersion === policy.version ? 'synced' : 'pending' };
}

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });
  return NextResponse.json({ ok: true, ...(await snapshot()) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!session.user.isAdmin) return NextResponse.json({ error: 'Administrator privileges required.' }, { status: 403 });
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!commandNames.has(name) || typeof body?.disabled !== 'boolean') {
    return NextResponse.json({ error: 'Choose a valid command and state.' }, { status: 400 });
  }
  await setMemberCommandDisabled(name, body.disabled);
  await recordActivity({ category: 'bot', action: body.disabled ? 'Member command disabled' : 'Member command enabled', actor: session.user.email, outcome: 'success', detail: name });
  return NextResponse.json({ ok: true, ...(await snapshot()) }, { headers: { 'Cache-Control': 'no-store' } });
}
