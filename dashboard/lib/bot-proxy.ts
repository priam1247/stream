import {
  enqueueBotCommand,
  getBotCommandById,
  getBotHeartbeat,
  getStoredWhatsAppUser,
  setFastPollWindow,
} from './storage';
import type { WhatsAppAccountStatus } from './types';
import { readAccountStatuses, serviceText } from './whatsapp-accounts';

/** A heartbeat older than this is reported as stale, never as a live probe. */
const HEARTBEAT_FRESH_SECONDS = 45;

export function normalizePhoneNumber(input: unknown): string {
  return String(input ?? '').replace(/[^0-9]/g, '');
}

/**
 * Everything the dashboard knows about the service comes from its outbound
 * heartbeat. There is no inbound bot port and no direct HTTP probe: a missing
 * or stale heartbeat is reported as such instead of being guessed at.
 */
export interface BotLiveStatus {
  reachable: boolean;
  connected: boolean | null;
  botNumber: string | null;
  accounts?: WhatsAppAccountStatus[];
  connectionMode: 'heartbeat' | 'unconfigured';
  lastSeenAt?: number | null;
  lastSeenSecondsAgo?: number | null;
  version?: string | null;
  whitelistVersion?: string | null;
  sessionBackup?: import('./types').BotHeartbeatRecord['sessionBackup'] | null;
  uptimeSeconds?: number | null;
  commandsTotal?: number | null;
  downloadsSuccess?: number | null;
  failedTotal?: number | null;
  ramUsedMB?: number | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  error?: string;
}

export async function fetchLiveBotStatus(): Promise<BotLiveStatus> {
  const hb = await getBotHeartbeat();
  if (!hb) {
    return {
      reachable: false,
      connected: null,
      botNumber: null,
      connectionMode: 'unconfigured',
    };
  }

  const ageSec = Math.max(0, Math.floor((Date.now() - hb.lastSeenAt) / 1000));
  const base = {
    botNumber: hb.botNumber || null,
    connectionMode: 'heartbeat' as const,
    lastSeenAt: hb.lastSeenAt,
    lastSeenSecondsAgo: ageSec,
    version: hb.version || null,
    whitelistVersion: hb.whitelistVersion || null,
    sessionBackup: hb.sessionBackup || null,
  };

  if (ageSec > HEARTBEAT_FRESH_SECONDS) {
    return {
      ...base,
      reachable: false,
      connected: null,
      uptimeSeconds: null,
      commandsTotal: null,
      downloadsSuccess: null,
      failedTotal: null,
      ramUsedMB: null,
      diskUsedMB: null,
      diskBudgetMB: null,
      queueLight: null,
      queueHeavy: null,
      error: `Offline (${ageSec}s since heartbeat).`,
    };
  }

  return {
    ...base,
    reachable: true,
    connected: typeof hb.connected === 'boolean' ? hb.connected : null,
    accounts: readAccountStatuses(hb.accounts),
    uptimeSeconds: hb.uptimeSeconds ?? null,
    commandsTotal: hb.commandsTotal ?? null,
    downloadsSuccess: hb.downloadsSuccess ?? null,
    failedTotal: hb.failedTotal ?? null,
    ramUsedMB: hb.ramUsedMB ?? null,
    diskUsedMB: hb.diskUsedMB ?? null,
    diskBudgetMB: hb.diskBudgetMB ?? null,
    queueLight: hb.queueLight ?? null,
    queueHeavy: hb.queueHeavy ?? null,
  };
}

/**
 * Wake the outbound sync poll so the bot picks up the authoritative number list
 * sooner. The list itself only ever travels bot-ward through /api/bot/sync.
 */
export async function requestWhitelistSync(): Promise<void> {
  await setFastPollWindow(30_000).catch(() => {});
}

export async function checkQueuedPairCommand(requestId: string, requestedBy?: string): Promise<{
  ok: boolean;
  status: number;
  pending?: boolean;
  code?: string;
  expiresInSeconds?: number;
  issuedAt?: number;
  error?: string;
}> {
  const cmd = await getBotCommandById(requestId);
  if (
    !cmd || cmd.type !== 'pair' ||
    (requestedBy && (cmd.requestedBy || '').toLowerCase() !== requestedBy.toLowerCase())
  ) {
    return { ok: false, status: 404, error: 'Pairing request not found.' };
  }
  // Approval can be revoked or ownership transferred while a request is in
  // flight. Never disclose an outstanding code to a no-longer-authorized user.
  const number = normalizePhoneNumber(cmd.payload?.number);
  const stored = number ? await getStoredWhatsAppUser(number) : null;
  if (!(stored?.enabled || stored?.pairAllowed) || (requestedBy && (stored.addedBy || '').toLowerCase() !== requestedBy.toLowerCase())) {
    return { ok: false, status: 403, error: 'This number is no longer approved for linking.' };
  }
  if (cmd.status === 'completed' && cmd.result?.code) {
    const reportedSeconds = Number(cmd.result.expiresInSeconds);
    const expiresInSeconds = Number.isFinite(reportedSeconds) ? Math.min(60, Math.max(1, reportedSeconds)) : 60;
    const reportedAt = Number(cmd.result.issuedAt);
    const receivedAt = Number(cmd.result._dashboardReceivedAt);
    // Both bounds are immutable: comparing with the current time would accept
    // a future timestamp on a later poll and silently extend the countdown.
    // Older results without a receipt timestamp use the conservative request time.
    const issuedAt = Number.isFinite(receivedAt) && receivedAt >= cmd.createdAt &&
      Number.isFinite(reportedAt) && reportedAt >= cmd.createdAt && reportedAt <= receivedAt
      ? reportedAt : cmd.createdAt;
    if (Date.now() >= issuedAt + expiresInSeconds * 1000) {
      return { ok: false, status: 410, error: 'This linking code has expired. Request a new one.' };
    }
    return {
      ok: true,
      status: 200,
      code: String(cmd.result.code),
      expiresInSeconds,
      issuedAt,
    };
  }
  if (cmd.status === 'failed') {
    return {
      ok: false,
      status: 409,
      error: serviceText(cmd.error || 'The service could not issue a linking code.'),
    };
  }
  if (Date.now() > cmd.expiresAt) {
    return {
      ok: false,
      status: 504,
      error: 'The service did not pick up the linking request before it expired.',
    };
  }
  return { ok: true, status: 202, pending: true };
}

export async function requestLiveBotPairingCode(
  number: string,
  label: string,
  requestedBy?: string,
  requireNumberOwnership = false,
): Promise<{
  ok: boolean;
  status: number;
  pending?: boolean;
  requestId?: string;
  code?: string;
  expiresInSeconds?: number;
  issuedAt?: number;
  error?: string;
}> {
  const stored = await getStoredWhatsAppUser(number);
  if (!(stored?.enabled || stored?.pairAllowed) ||
      (requireNumberOwnership && (!requestedBy || (stored.addedBy || '').toLowerCase() !== requestedBy.toLowerCase()))) {
    return { ok: false, status: 403, error: 'This number is no longer allowed to link.' };
  }

  await setFastPollWindow(60_000).catch(() => {});
  const queued = await enqueueBotCommand({
    type: 'pair', payload: { number, label }, requestedBy, ttlMs: 90_000,
  });
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const check = await checkQueuedPairCommand(queued.id, requireNumberOwnership ? requestedBy : undefined);
    if (!check.pending) return check;
  }
  return { ok: true, status: 202, pending: true, requestId: queued.id };
}

/** Dispatch a version-guarded unlink; never fall back to removing approval alone. */
export async function requestLiveBotUnlink(number: string, sessionId: string, owner: string, claimKey: string, requestedBy = owner): Promise<{
  ok: boolean; status: number; pending?: boolean; requestId?: string; error?: string;
}> {
  const cmd = await enqueueBotCommand({
    type: 'unlink',
    payload: { number, sessionId, owner: owner.toLowerCase(), claimKey },
    requestedBy,
    ttlMs: 90_000,
  });
  return { ok: true, status: 202, pending: true, requestId: cmd.id };
}
