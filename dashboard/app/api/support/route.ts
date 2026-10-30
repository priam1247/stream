import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { addSupportMessage, countMemberSupportUnread, isUsingCloudflareD1, listSupportMessages, listSupportThreads } from '@/lib/storage';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers });
  if (process.env.NODE_ENV === 'production' && !(await isUsingCloudflareD1())) return NextResponse.json({ error: 'Reports require durable D1 storage to be configured.' }, { status: 503, headers });
  const summary = req.nextUrl.searchParams.get('summary') === '1';
  if (session.user.isAdmin) {
    const threads = await listSupportThreads();
    const email = req.nextUrl.searchParams.get('thread')?.trim().toLowerCase() || '';
    if (!email) return NextResponse.json({ ok: true, threads, unread: threads.reduce((n, item) => n + item.unread, 0) }, { headers });
    if (!threads.some((item) => item.email === email)) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404, headers });
    const messages = await listSupportMessages(email, 'admin');
    // The read cursor has advanced; return fresh counts rather than the
    // pre-read snapshot so the navigation badge updates immediately.
    const updatedThreads = await listSupportThreads();
    return NextResponse.json({ ok: true, messages, threads: updatedThreads, unread: updatedThreads.reduce((n, item) => n + item.unread, 0) }, { headers });
  }
  if (summary) return NextResponse.json({ ok: true, unread: await countMemberSupportUnread(session.user.email) }, { headers });
  // Ignore any supplied thread: a member can access only their own conversation.
  return NextResponse.json({ ok: true, messages: await listSupportMessages(session.user.email, 'member') }, { headers });
}

async function readMessageBody(req: NextRequest): Promise<unknown> {
  if (Number(req.headers.get('content-length') || 0) > 8192 || !req.body) return null;
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    total += part.value.byteLength;
    if (total > 8192) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) return NextResponse.json({ error: 'Authentication required.' }, { status: 401, headers });
  if (process.env.NODE_ENV === 'production' && !(await isUsingCloudflareD1())) return NextResponse.json({ error: 'Reports require durable D1 storage to be configured.' }, { status: 503, headers });
  const body = await readMessageBody(req) as { text?: unknown; thread?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) return NextResponse.json({ error: 'Enter a message of up to 2,000 characters.' }, { status: 400, headers });
  const email = session.user.isAdmin ? String(body?.thread || '').trim().toLowerCase() : session.user.email.toLowerCase();
  if (session.user.isAdmin && !(await listSupportThreads()).some((item) => item.email === email)) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404, headers });
  }
  const message = await addSupportMessage(email, session.user.isAdmin ? 'admin' : 'member', text);
  if (!message) return NextResponse.json({ error: 'Please wait a few seconds before sending another message.' }, { status: 429, headers: { ...headers, 'Retry-After': '5' } });
  return NextResponse.json({ ok: true, message }, { status: 201, headers });
}
