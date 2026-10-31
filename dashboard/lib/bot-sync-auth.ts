import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { getBotConnectionConfig } from './storage';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // ±5 minutes
const MAX_NONCE_CACHE = 4096;

declare global {
  // eslint-disable-next-line no-var
  var __zafarBotReplayNonces: Map<string, number> | undefined;
}

function getNonceMap(): Map<string, number> {
  if (!globalThis.__zafarBotReplayNonces) {
    globalThis.__zafarBotReplayNonces = new Map();
  }
  return globalThis.__zafarBotReplayNonces;
}

function timingSafeStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function consumeNonce(nonce: string, now = Date.now()): boolean {
  const map = getNonceMap();
  for (const [k, exp] of map.entries()) {
    if (exp <= now) map.delete(k);
  }
  if (map.has(nonce)) return false;
  if (map.size >= MAX_NONCE_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(nonce, now + MAX_CLOCK_SKEW_MS);
  return true;
}

type CredentialRole = 'legacy' | 'xs' | 'botkeep';
type SyncAuthentication = { ok: true; status: 200; credentialRole: CredentialRole }
  | { ok: false; status: number; error: string };

export async function verifyBotSyncRequest(
  req: NextRequest,
  rawBody = '',
): Promise<SyncAuthentication> {
  const cfg = await getBotConnectionConfig();
  const candidates: { secret: string; role: CredentialRole }[] = [
    ...[cfg.botSyncToken, cfg.botAdminToken, process.env.BOT_SYNC_TOKEN, process.env.ADMIN_DASHBOARD_TOKEN]
      .map((secret) => ({ secret: (secret || '').trim(), role: 'legacy' as const })),
    { secret: (cfg.botXsSyncToken || '').trim(), role: 'xs' as const },
    { secret: (cfg.botBotkeepSyncToken || '').trim(), role: 'botkeep' as const },
  ].filter(({ secret }) => Boolean(secret));

  if (candidates.length === 0) {
    return { ok: false, status: 503, error: 'Service sync credentials are not configured on the portal yet.' };
  }

  const providedBearer =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    req.headers.get('x-bot-token')?.trim() ||
    req.headers.get('x-admin-token')?.trim() ||
    '';

  const matches = candidates.filter(({ secret }) => providedBearer && timingSafeStr(providedBearer, secret));
  if (!matches.length) return { ok: false, status: 401, error: 'Unauthorized service token.' };
  // A credential that belongs to more than one role cannot establish which
  // host is calling. Reject it rather than assigning whichever role matched first.
  if (new Set(matches.map(({ role }) => role)).size !== 1) {
    return { ok: false, status: 503, error: 'Service credentials overlap; configure distinct host tokens.' };
  }
  const { secret: matchedSecret, role: credentialRole } = matches[0];
  if (credentialRole !== 'legacy' && (matchedSecret.length < 32 || matchedSecret.length > 512)) {
    return { ok: false, status: 503, error: 'Each host credential must be between 32 and 512 characters.' };
  }

  const tsHeader = req.headers.get('x-bot-timestamp')?.trim();
  const nonceHeader = req.headers.get('x-bot-nonce')?.trim();
  const sigHeader = req.headers.get('x-bot-signature')?.trim();

  // Legacy single-host requests retain bearer-only compatibility. Host-bound
  // credentials are never valid without a fresh signed request.
  if (credentialRole !== 'legacy' && (!tsHeader || !nonceHeader || !sigHeader)) {
    return { ok: false, status: 401, error: 'Signed host request required.' };
  }

  // Signed requests enforce timestamp freshness + one-time nonce + HMAC-SHA256
  if (tsHeader || nonceHeader || sigHeader) {
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
      return {
        ok: false,
        status: 401,
        error: 'Service request timestamp outside allowed 5-minute window.',
      };
    }
    if (!nonceHeader || nonceHeader.length < 8) {
      return { ok: false, status: 409, error: 'Duplicate or invalid service request nonce (replay blocked).' };
    }
    const expectedSig =
      'sha256=' +
      crypto
        .createHmac('sha256', matchedSecret)
        .update(`${tsHeader}.${nonceHeader}.${rawBody}`)
        .digest('hex');
    if (!sigHeader || !timingSafeStr(sigHeader, expectedSig)) {
      return { ok: false, status: 401, error: 'Invalid service HMAC signature.' };
    }
    if (!consumeNonce(nonceHeader)) {
      return { ok: false, status: 409, error: 'Duplicate or invalid service request nonce (replay blocked).' };
    }
  }

  return { ok: true, status: 200, credentialRole };
}
