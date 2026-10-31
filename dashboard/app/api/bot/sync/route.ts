import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail } from '@/lib/auth-engine';
import { verifyBotSyncRequest } from '@/lib/bot-sync-auth';
import { readAccountStatuses } from '@/lib/whatsapp-accounts';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitHit,
} from '@/lib/rate-limit';
import {
  claimFailoverLease,
  claimPendingBotCommands,
  completeBotCommand,
  computeWhitelistSnapshot,
  getBotHeartbeat,
  getFailoverStatus,
  getMemberCommandPolicy,
  getNextBotPollMs,
  getStoredWhatsAppUser,
  importLocalUserForLease,
  saveBotHeartbeat,
  type FailoverFence,
  type FailoverIdentity,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

const SYNC_WINDOW_MS = 60 * 1000;
const MAX_SYNC_PER_MINUTE = 120;

export async function POST(req: NextRequest) {
  const ipKey = `botsync:ip:${getClientIp(req)}`;
  const rate = checkRateLimit(ipKey, MAX_SYNC_PER_MINUTE, SYNC_WINDOW_MS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }
  recordRateLimitHit(ipKey, SYNC_WINDOW_MS);

  const rawBody = await req.text().catch(() => '');
  const auth = await verifyBotSyncRequest(req, rawBody);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: Record<string, unknown> = {};
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object') body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  let lease: Awaited<ReturnType<typeof claimFailoverLease>> | undefined;
  let fence: FailoverFence | undefined;
  let reportedEpoch = 0;
  if (body.failover !== undefined) {
    if (!body.failover || typeof body.failover !== 'object' || Array.isArray(body.failover)) {
      return NextResponse.json({ error: 'Invalid failover identity.' }, { status: 400 });
    }
    const raw = body.failover as Record<string, unknown>;
    if ((raw.role !== 'xs' && raw.role !== 'botkeep') || typeof raw.instance !== 'string' || !/^[a-f0-9]{32}$/.test(raw.instance)) {
      return NextResponse.json({ error: 'Invalid failover identity.' }, { status: 400 });
    }
    // The generic sync endpoint retains bearer-only compatibility for legacy
    // single-node installations; failover messages must always be signed.
    if (!req.headers.get('x-bot-timestamp') || !req.headers.get('x-bot-nonce') || !req.headers.get('x-bot-signature')) {
      return NextResponse.json({ error: 'Signed requests are required for failover.' }, { status: 401 });
    }
    const identity: FailoverIdentity = { role: raw.role, instance: raw.instance };
    reportedEpoch = Number.isSafeInteger(raw.epoch) ? Number(raw.epoch) : 0;
    try {
      // Fail over the owner's primary pairing device, not merely any one of
      // the optional linked member sessions that happen to remain online.
      lease = await claimFailoverLease(identity, { connected: raw.primaryConnected === true,
        accountNumber: typeof body.botNumber === 'string' ? body.botNumber.replace(/\D/g, '') : '',
        deviceFingerprint: typeof raw.deviceFingerprint === 'string' ? raw.deviceFingerprint : '',
        version: typeof body.version === 'string' ? body.version : '' });
    } catch {
      return NextResponse.json({ error: 'Shared failover storage is unavailable.' }, { status: 503 });
    }
    if (lease.granted && lease.epoch) fence = { ...identity, epoch: lease.epoch };
  } else if ((await getFailoverStatus()).enabled) {
    // Old versions cannot be trusted to stop serving after a lease expires.
    return NextResponse.json({ error: 'This dashboard requires the updated failover service.' }, { status: 409 });
  }
  const mayServe = !lease || Boolean(fence);

  // 1. Import any unsynced WhatsApp `.allow` numbers from the active bot into D1
  let importedAnyLocal = false;
  if (mayServe && Array.isArray(body.localUsers)) {
    const adminOwner = getAdminEmail();
    for (const raw of body.localUsers.slice(0, 200)) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const num = String(item.number || '').replace(/[^0-9]/g, '');
      if (num.length < 7 || num.length > 15) continue;
      const existing = await getStoredWhatsAppUser(num);
      if (!existing) {
        const label = String(item.label || 'Added via WhatsApp .allow').slice(0, 60);
        importedAnyLocal = await importLocalUserForLease(num, label, adminOwner, fence) || importedAnyLocal;
      }
    }
  }

  // 2. Record completed command results reported by the bot
  if (mayServe && (!lease || reportedEpoch === fence?.epoch) && Array.isArray(body.completedResults)) {
    for (const item of body.completedResults) {
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        await completeBotCommand({
          id: item.id,
          ok: Boolean(item.ok),
          result:
            item.result && typeof item.result === 'object'
              ? (item.result as Record<string, unknown>)
              : undefined,
          error: typeof item.error === 'string' ? item.error : undefined,
        }, fence);
      }
    }
  }

  // 3. Store fresh bot heartbeat + live telemetry counters
  const prevHb = mayServe ? await getBotHeartbeat() : null;
  if (mayServe) await saveBotHeartbeat({
    lastSeenAt: Date.now(),
    connected: typeof body.connected === 'boolean' ? body.connected : null,
    botNumber: body.botNumber ? String(body.botNumber) : null,
    accounts: readAccountStatuses(body.accounts),
    botName: typeof body.botName === 'string' ? body.botName : prevHb?.botName,
    version: typeof body.version === 'string' ? body.version : prevHb?.version,
    uptimeSeconds:
      typeof body.uptimeSeconds === 'number' ? body.uptimeSeconds : prevHb?.uptimeSeconds,
    commandsTotal: typeof body.commandsTotal === 'number' ? body.commandsTotal : undefined,
    downloadsSuccess: typeof body.downloadsSuccess === 'number' ? body.downloadsSuccess : undefined,
    failedTotal: typeof body.failedTotal === 'number' ? body.failedTotal : undefined,
    ramUsedMB: typeof body.ramUsedMB === 'number' ? body.ramUsedMB : undefined,
    diskUsedMB: typeof body.diskUsedMB === 'number' ? body.diskUsedMB : undefined,
    diskBudgetMB: typeof body.diskBudgetMB === 'number' ? body.diskBudgetMB : undefined,
    queueLight: typeof body.queueLight === 'number' ? body.queueLight : undefined,
    queueHeavy: typeof body.queueHeavy === 'number' ? body.queueHeavy : undefined,
    whitelistVersion:
      typeof body.whitelistVersion === 'string' && /^[a-f0-9]{16}$/i.test(body.whitelistVersion)
        ? body.whitelistVersion.toLowerCase()
        : undefined,
    commandPolicyVersion: typeof body.commandPolicyVersion === 'string' && /^[a-f0-9]{16}$/i.test(body.commandPolicyVersion)
      ? body.commandPolicyVersion.toLowerCase() : undefined,
    ...(fence ? { failover: { role: fence.role, epoch: fence.epoch } } : {}),
    sessionBackup: (() => {
      const raw = body.sessionBackup;
      if (!raw || typeof raw !== 'object' || !('state' in raw)) return undefined;
      const state = String(raw.state);
      if (!['disabled', 'starting', 'ready', 'error', 'conflict'].includes(state)) return undefined;
      const last = 'lastBackupAt' in raw ? Number(raw.lastBackupAt) : 0;
      const sessions = 'sessions' in raw ? Number(raw.sessions) : NaN;
      const backedUp = 'backedUp' in raw ? Number(raw.backedUp) : NaN;
      const counts = Number.isSafeInteger(sessions) && sessions >= 0 && sessions <= 101 && Number.isSafeInteger(backedUp) && backedUp >= 0 && backedUp <= sessions ? { sessions, backedUp } : {};
      return { state: state as 'disabled' | 'starting' | 'ready' | 'error' | 'conflict', lastBackupAt: Number.isSafeInteger(last) && last > 0 && last <= Date.now() + 60000 ? last : null, ...counts };
    })(),
  }, fence);

  // 4. Both nodes receive permissions; only the lease holder claims commands.
  const [snapshot, commands, nextPollMs, policy] = await Promise.all([
    computeWhitelistSnapshot(),
    mayServe ? claimPendingBotCommands(fence) : Promise.resolve([]),
    getNextBotPollMs(),
    getMemberCommandPolicy(),
  ]);

  const clientVersion =
    typeof body.whitelistVersion === 'string' ? body.whitelistVersion.trim() : '';
  const whitelistChanged = importedAnyLocal || clientVersion !== snapshot.version;

  return NextResponse.json({
    ok: true,
    serverTime: Date.now(),
    nextPollMs: commands.length > 0 ? 2_000 : lease ? Math.min(nextPollMs, 5_000) : nextPollMs,
    ...(lease ? { failover: lease } : {}),
    whitelistVersion: snapshot.version,
    whitelistChanged,
    commandPolicyVersion: policy.version,
    disabledMemberCommands: policy.disabled,
    ...(whitelistChanged
      ? {
          botEnabledForMembers: snapshot.botEnabledForMembers,
          users: snapshot.users,
          numbers: snapshot.numbers,
        }
      : {}),
    commands: commands.map((c) => ({
      id: c.id,
      type: c.type,
      payload: c.payload,
      expiresAt: c.expiresAt,
    })),
  });
}
