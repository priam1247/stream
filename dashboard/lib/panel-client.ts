import crypto from 'node:crypto';
import { PANEL_BASE_URL, isPanelServerId } from './panel-config';
import { getPanelConnectionConfig } from './storage';
import type { PanelLiveStatus } from './types';

const STATUS_TIMEOUT_MS = 4_000;
const ACTION_TIMEOUT_MS = 12_000;

type HiddenCloudConfig = { panelServerId: string; panelApiKey: string };
function validKey(key: string): boolean {
  return /^[\x21-\x7e]{16,512}$/.test(key);
}
function configError(cfg: HiddenCloudConfig): string | null {
  if (!cfg.panelServerId || !cfg.panelApiKey) return 'Configure the HiddenCloud server ID and client API key first.';
  if (!isPanelServerId(cfg.panelServerId)) return 'The HiddenCloud server ID is invalid.';
  if (!validKey(cfg.panelApiKey)) return 'The HiddenCloud API key is invalid.';
  return null;
}
function endpoint(id: string): string {
  return `${PANEL_BASE_URL}/api/client/servers/${encodeURIComponent(id)}`;
}
function reportedState(body: unknown): PanelLiveStatus['state'] {
  if (!body || typeof body !== 'object') return 'unknown';
  const root = body as Record<string, unknown>;
  const nested = root.attributes || root.workload || root.bot || root.data;
  const item = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : root;
  if (item.is_suspended === true || item.suspended === true) return 'suspended';
  const raw = typeof item.current_state === 'string' ? item.current_state
    : typeof item.status === 'string' ? item.status
    : typeof item.state === 'string' ? item.state : '';
  switch (raw.toLowerCase()) {
    case 'running': case 'online': return 'running';
    case 'offline': case 'stopped': return 'offline';
    case 'starting': return 'starting';
    case 'stopping': return 'stopping';
    case 'suspended': return 'suspended';
    default: return 'unknown';
  }
}

/** A service heartbeat is not a hosting status; query HiddenCloud only when explicitly configured. */
export async function readPanelStatus(custom?: HiddenCloudConfig): Promise<PanelLiveStatus> {
  const cfg = custom || await getPanelConnectionConfig();
  const checkedAt = Date.now();
  const base: PanelLiveStatus = { configured: Boolean(cfg.panelApiKey && cfg.panelServerId), reachable: null, state: 'unknown', error: null, checkedAt };
  if (!base.configured) return base;
  const error = configError(cfg);
  if (error) return { ...base, error };
  try {
    const res = await fetch(`${endpoint(cfg.panelServerId)}/resources`, {
      headers: { Authorization: `Bearer ${cfg.panelApiKey}`, Accept: 'application/vnd.pterodactyl.v1+json' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { ...base, reachable: true, error: res.status === 401 || res.status === 403
      ? 'HiddenCloud credentials were rejected.' : 'HiddenCloud did not provide server status.' };
    const body = await res.json().catch(() => null);
    return { ...base, reachable: true, state: reportedState(body) };
  } catch {
    return { ...base, reachable: false, error: 'HiddenCloud status could not be reached.' };
  }
}

/** Send exactly one action to the explicitly selected HiddenCloud server. */
export async function sendPanelPowerSignal(signal: 'restart' | 'start' | 'stop', target?: HiddenCloudConfig): Promise<{
  ok: boolean; status: number; serverId?: string; message?: string; error?: string;
}> {
  const cfg = target || await getPanelConnectionConfig();
  const error = configError(cfg);
  if (error) return { ok: false, status: 400, error };
  try {
    const res = await fetch(`${endpoint(cfg.panelServerId)}/power`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.panelApiKey}`,
        Accept: 'application/vnd.pterodactyl.v1+json', 'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ signal }),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, status: res.status, serverId: cfg.panelServerId, message: 'HiddenCloud accepted the request; check its status for completion.' };
    if ([400, 401, 403, 404, 405, 422, 429].includes(res.status)) {
      return { ok: false, status: res.status, error: 'HiddenCloud rejected the power request. Check the server ID, key permissions, and rate limit.' };
    }
    return { ok: false, status: res.status || 502, error: 'HiddenCloud did not confirm the result. Check server status before retrying.' };
  } catch {
    return { ok: false, status: 502, error: 'HiddenCloud did not confirm the result. Check server status before retrying.' };
  }
}
