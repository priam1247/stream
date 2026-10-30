import { NextRequest, NextResponse } from 'next/server';
import { verifyBotSyncRequest } from '@/lib/bot-sync-auth';
import { getEligibleSessionBackup, getSessionBackup, getStoredWhatsAppUser, isUsingCloudflareD1, listSessionBackupMetadata, putSessionBackup, revokeSessionBackup, sessionBackupClaim } from '@/lib/storage';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const MAX_BODY = 1_100_000;
const validSlot = (value: unknown): value is string => typeof value === 'string' && (value === 'primary' || /^linked:\d{7,15}$/.test(value));
async function claimForSlot(slot: string) {
  if (slot === 'primary') return { token: 'primary', identity: null };
  const user = await getStoredWhatsAppUser(slot.slice(7));
  if (!user || !(user.enabled || user.pairAllowed)) return null;
  return sessionBackupClaim(user);
}

/** Read with an actual streaming bound, not just an optional Content-Length. */
async function boundedBody(req: NextRequest): Promise<string | null> {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY || !req.body) return null;
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production' && req.nextUrl.protocol !== 'https:' && req.headers.get('x-forwarded-proto') !== 'https') {
    return NextResponse.json({ error: 'Encrypted transport required.' }, { status: 403, headers });
  }
  const raw = await boundedBody(req);
  if (raw === null) return NextResponse.json({ error: 'Backup request is too large.' }, { status: 413, headers });
  // Recovery always requires the signed form of the bot protocol, not a bearer alone.
  if (!req.headers.get('x-bot-timestamp') || !req.headers.get('x-bot-nonce') || !req.headers.get('x-bot-signature')) {
    return NextResponse.json({ error: 'Signed service request required.' }, { status: 401, headers });
  }
  const auth = await verifyBotSyncRequest(req, raw);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  if (!(await isUsingCloudflareD1())) return NextResponse.json({ error: 'Durable D1 storage is not configured.' }, { status: 503, headers });
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers }); }
  if (data.action === 'list') {
    const after = data.after === undefined ? '' : data.after;
    if (after !== '' && !validSlot(after)) return NextResponse.json({ error: 'Invalid backup cursor.' }, { status: 400, headers });
    const records = await listSessionBackupMetadata(String(after));
    return NextResponse.json({ ok: true, records }, { headers });
  }
  const slot = data.slot;
  if (!validSlot(slot)) return NextResponse.json({ error: 'Invalid backup slot.' }, { status: 400, headers });
  if (data.action === 'meta') {
    const record = await getSessionBackup(slot);
    if (!record) return NextResponse.json({ error: 'Backup not available.' }, { status: 404, headers });
    const { ciphertext: _ciphertext, ...metadata } = record;
    return NextResponse.json({ ok: true, record: metadata }, { headers });
  }
  if (data.action === 'revoke') {
    const generation = typeof data.generation === 'string' ? data.generation : '';
    if (!/^[a-f0-9]{24}$/.test(generation)) return NextResponse.json({ error: 'Invalid generation.' }, { status: 400, headers });
    await revokeSessionBackup(slot, generation);
    return NextResponse.json({ ok: true }, { headers });
  }
  const claim = await claimForSlot(slot);
  if (!claim) return NextResponse.json({ error: 'This session is not eligible for recovery.' }, { status: 403, headers });
  if (data.action === 'get') {
    const record = await getEligibleSessionBackup(slot, claim.token, claim.identity);
    if (!record) return NextResponse.json({ error: 'Backup not available.' }, { status: 404, headers });
    return NextResponse.json({ ok: true, record }, { headers });
  }
  if (data.action === 'put') {
    const generation = typeof data.generation === 'string' ? data.generation : '';
    const ciphertext = typeof data.ciphertext === 'string' ? data.ciphertext : '';
    const revision = data.revision;
    if (!/^[a-f0-9]{24}$/.test(generation) || data.claimToken !== claim.token ||
        !Number.isSafeInteger(revision) || Number(revision) < 0 || !/^v1:[A-Za-z0-9+/=:.]+$/.test(ciphertext) || ciphertext.length > 1_000_000) {
      return NextResponse.json({ error: 'Invalid encrypted backup.' }, { status: 400, headers });
    }
    const next = await putSessionBackup(slot, generation, claim.token, ciphertext, Number(revision), claim.identity);
    if (next == null) return NextResponse.json({ error: 'Backup changed; refresh before retrying.' }, { status: 409, headers });
    return NextResponse.json({ ok: true, revision: next }, { headers });
  }
  return NextResponse.json({ error: 'Invalid action.' }, { status: 400, headers });
}
