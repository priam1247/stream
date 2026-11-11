import { NextRequest, NextResponse } from 'next/server';
import { verifyBotSyncRequest } from '@/lib/bot-sync-auth';
import { readAccountStatuses } from '@/lib/whatsapp-accounts';
import { changedConfirmedLinks, mergeConfirmedLinks, readServiceMemberUsage } from '@/lib/member-insights-server';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitHit,
} from '@/lib/rate-limit';
import {
  claimPendingBotCommands,
  completeBotCommand,
  computeWhitelistSnapshot,
  getBotHeartbeat,
  getNextBotPollMs,
  releaseClaimedBotCommands,
  saveBotHeartbeatIfNewer,
  saveConfirmedMemberLinks,
  serializeWhitelistUsers,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

const SYNC_WINDOW_MS = 60 * 1000;
const MAX_SYNC_PER_MINUTE = 120;
const SYNC_FIELDS = new Set([
  'connected', 'botNumber', 'accounts', 'botName', 'version', 'uptimeSeconds',
  'commandsTotal', 'downloadsSuccess', 'failedTotal', 'ramUsedMB', 'queueLight',
  'queueHeavy', 'diskUsedMB', 'diskBudgetMB', 'whitelistVersion',
  'sessionBackup', 'completedResults', 'memberUsage',
  // Accepted for rolling upgrades, but deliberately ignored.
  'localUsers', 'commandPolicyVersion',
]);

export async function POST(req: NextRequest) {
  // Record actual receipt, not the time a slow database write finally finishes.
  const receivedAt = Date.now();
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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // A client speaking an obsolete protocol must not consume commands it cannot
  // execute. Reject unknown fields before any heartbeat or queue mutation.
  if (Object.keys(body).some((key) => !SYNC_FIELDS.has(key))) {
    return NextResponse.json({ error: 'Unsupported service protocol. Update the Botkeep service.' }, { status: 409 });
  }

  // Record completed command results reported by the bot.
  if (Array.isArray(body.completedResults)) {
    await Promise.all(body.completedResults.slice(0, 100).map((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') return Promise.resolve();
      return completeBotCommand({
        id: item.id,
        ok: Boolean(item.ok),
        result:
          item.result && typeof item.result === 'object'
            ? (item.result as Record<string, unknown>)
            : undefined,
        error: typeof item.error === 'string' ? item.error : undefined,
      });
    }));
  }

  // Store fresh bot heartbeat + live telemetry counters.
  const [prevHb, snapshot] = await Promise.all([getBotHeartbeat(), computeWhitelistSnapshot()]);
  const accounts = readAccountStatuses(body.accounts);
  const memberUsage = readServiceMemberUsage(body.memberUsage, snapshot.users, receivedAt) || prevHb?.memberUsage;
  const confirmedLinks = mergeConfirmedLinks(prevHb, accounts, snapshot.users, receivedAt);
  await saveConfirmedMemberLinks(changedConfirmedLinks(confirmedLinks, prevHb?.confirmedLinks), snapshot.users);
  await saveBotHeartbeatIfNewer({
    lastSeenAt: receivedAt,
    connected: typeof body.connected === 'boolean' ? body.connected : null,
    botNumber: body.botNumber ? String(body.botNumber) : null,
    accounts,
    confirmedLinks,
    ...(memberUsage ? { memberUsage } : {}),
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
  });

  // A member can register and enqueue pairing after the heartbeat snapshot was
  // read but before this tick claims commands. Re-read after claiming so the
  // bot receives the corresponding permission before it executes the request.
  const commands = await claimPendingBotCommands();
  let responseSnapshot: typeof snapshot;
  let nextPollMs: number;
  try {
    [responseSnapshot, nextPollMs] = await Promise.all([
      commands.length ? computeWhitelistSnapshot() : Promise.resolve(snapshot),
      getNextBotPollMs(),
    ]);
  } catch (error) {
    await releaseClaimedBotCommands(commands.map((command) => command.id)).catch(() => {});
    throw error;
  }
  const clientVersion =
    typeof body.whitelistVersion === 'string' ? body.whitelistVersion.trim() : '';
  const whitelistChanged = clientVersion !== responseSnapshot.version;

  return NextResponse.json({
    ok: true,
    serverTime: Date.now(),
    nextPollMs: commands.length > 0 ? 2_000 : nextPollMs,
    whitelistVersion: responseSnapshot.version,
    whitelistChanged,
    ...(whitelistChanged ? { users: serializeWhitelistUsers(responseSnapshot.users) } : {}),
    commands: commands.map((c) => ({
      id: c.id,
      type: c.type,
      payload: c.payload,
      expiresAt: c.expiresAt,
    })),
  });
}
