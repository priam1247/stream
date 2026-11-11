import {
  enqueueBotCommand,
  getBotCommandById,
  getBotConnectionConfig,
  getBotHeartbeat,
  getStoredWhatsAppUser,
  setFastPollWindow,
} from './storage';
import type { WhatsAppAccountStatus } from './types';
import { readAccountStatuses, serviceText } from './whatsapp-accounts';

const STATUS_TIMEOUT_MS = 3_000;
export const HEARTBEAT_FRESH_SECONDS = 45;

export function normalizePhoneNumber(input: unknown): string {
  return String(input ?? '').replace(/[^0-9]/g, '');
}

export function parseAndValidateBotUrl(rawUrl: string): {
  baseUrl: string | null;
  hostLabel: string | null;
  isInsecureHttp?: boolean;
  error?: string;
} {
  const raw = rawUrl.trim();
  if (!raw) return { baseUrl: null, hostLabel: null };

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        baseUrl: null,
        hostLabel: null,
        error: 'Service URL must start with http:// or https://',
      };
    }
    const cleanPath = parsed.pathname
      .replace(/\/admin\/api\/?$/i, '')
      .replace(/\/admin\/?$/i, '')
      .replace(/\/+$/, '');
    const isLocalhost =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return {
      baseUrl: `${parsed.origin}${cleanPath}`,
      hostLabel: parsed.host,
      isInsecureHttp: parsed.protocol === 'http:' && !isLocalhost,
    };
  } catch {
    return {
      baseUrl: null,
      hostLabel: null,
      error:
        'Invalid service URL format (use an HTTPS origin or leave blank for outbound heartbeat sync)',
    };
  }
}

export async function getResolvedBotTarget(): Promise<{
  baseUrl: string | null;
  hostLabel: string | null;
  isInsecureHttp: boolean;
  token: string;
  syncToken: string;
  botEnabledForMembers: boolean;
  rawUrl: string;
}> {
  const cfg = await getBotConnectionConfig();
  const parsed = parseAndValidateBotUrl(cfg.botApiUrl);
  return {
    baseUrl: parsed.baseUrl,
    hostLabel: parsed.hostLabel,
    isInsecureHttp: Boolean(parsed.isInsecureHttp),
    token: cfg.botAdminToken,
    syncToken: cfg.botSyncToken,
    botEnabledForMembers: cfg.botEnabledForMembers,
    rawUrl: cfg.botApiUrl,
  };
}

function humanizeBotFetchError(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Unable to reach the WhatsApp server';
  if (/aborted|timeout/i.test(raw)) {
    return 'WhatsApp server offline or unreachable (request timed out).';
  }
  if (/ECONNREFUSED|fetch failed/i.test(raw)) {
    return 'WhatsApp server offline or port closed.';
  }
  return serviceText(raw);
}

export async function fetchLiveBotStatus(customTarget?: {
  baseUrl: string;
  token: string;
}): Promise<{
  reachable: boolean;
  connected: boolean | null;
  botNumber: string | null;
  accounts?: WhatsAppAccountStatus[];
  connectionMode: 'heartbeat' | 'direct' | 'unconfigured';
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
  latencyMs?: number;
  error?: string;
}> {
  if (!customTarget) {
    const hb = await getBotHeartbeat();
    if (hb) {
      const ageSec = Math.max(0, Math.floor((Date.now() - hb.lastSeenAt) / 1000));
      if (ageSec <= HEARTBEAT_FRESH_SECONDS) {
        return {
          reachable: true,
          connected: typeof hb.connected === 'boolean' ? hb.connected : null,
          botNumber: hb.botNumber || null,
          accounts: readAccountStatuses(hb.accounts),
          connectionMode: 'heartbeat',
          lastSeenAt: hb.lastSeenAt,
          lastSeenSecondsAgo: ageSec,
          version: hb.version || null,
          whitelistVersion: hb.whitelistVersion || null,
          sessionBackup: hb.sessionBackup || null,
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
    }

    const resolved = await getResolvedBotTarget();
    if (!resolved.baseUrl) {
      if (hb) {
        const ageSec = Math.max(0, Math.floor((Date.now() - hb.lastSeenAt) / 1000));
        return {
          reachable: false,
          connected: null,
          botNumber: hb.botNumber || null,
          connectionMode: 'heartbeat',
          lastSeenAt: hb.lastSeenAt,
          lastSeenSecondsAgo: ageSec,
          version: hb.version || null,
          whitelistVersion: hb.whitelistVersion || null,
          sessionBackup: hb.sessionBackup || null,
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
        reachable: false,
        connected: null,
        botNumber: null,
        connectionMode: 'unconfigured',
      };
    }

    return probeDirectBotStatus(resolved);
  }

  return probeDirectBotStatus(customTarget);
}

async function probeDirectBotStatus(target: {
  baseUrl: string | null;
  token: string;
}): Promise<{
  reachable: boolean;
  connected: boolean | null;
  botNumber: string | null;
  accounts?: WhatsAppAccountStatus[];
  connectionMode: 'direct';
  latencyMs?: number;
  error?: string;
}> {
  if (!target.baseUrl) {
    return {
      reachable: false,
      connected: null,
      botNumber: null,
      connectionMode: 'direct',
    };
  }
  if (!target.token) {
    return {
      reachable: false,
      connected: null,
      botNumber: null,
      connectionMode: 'direct',
      error: 'ADMIN_DASHBOARD_TOKEN is not set yet.',
    };
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${target.baseUrl}/admin/api/status`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${target.token}`,
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errorMsg =
        res.status === 401
          ? 'ADMIN_DASHBOARD_TOKEN mismatch (service rejected token with HTTP 401).'
          : data?.error || `Service returned HTTP ${res.status}`;
      return {
        reachable: false,
        connected: null,
        botNumber: null,
        connectionMode: 'direct',
        latencyMs,
        error: serviceText(String(errorMsg)),
      };
    }
    return {
      reachable: true,
      connected: typeof data.connected === 'boolean' ? data.connected : null,
      botNumber: data.botNumber ? String(data.botNumber) : null,
      accounts: readAccountStatuses(data.accounts),
      connectionMode: 'direct',
      latencyMs,
    };
  } catch (err) {
    return {
      reachable: false,
      connected: null,
      botNumber: null,
      connectionMode: 'direct',
      error: humanizeBotFetchError(err),
    };
  }
}

/** Wake the outbound sync poll so the bot receives the authoritative list sooner. */
export async function syncNumberToLiveBot(
  _number: string,
  _label: string,
  _enabled: boolean,
  _pairAllowed = false,
): Promise<'accepted' | 'pending'> {
  // The authoritative list is returned by /api/bot/sync. Never mirror it
  // through the optional direct admin API.
  await setFastPollWindow(30_000).catch(() => {});
  return 'pending';
}

export async function removeNumberFromLiveBot(_number: string): Promise<void> {
  // Withdrawal is reflected in the next authoritative whitelist snapshot.
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
