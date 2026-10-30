import type { RoomAlert, ScribdSnapshot } from './control-room';
import type { AdminOverviewPayload, PanelLiveStatus } from './types';

export type ReadRoomAlerts = Record<string, string>;
const PREFIX = 'zafar-room-alert-reads-v1:';
const ALERT_IDS = new Set([
  'panel-suspended', 'panel-offline', 'panel-credentials', 'panel-status',
  'status', 'bot-link', 'bot-unreachable', 'whatsapp', 'scribd-token',
  'scribd-transport', 'number-sync', 'disk', 'scribd-offline', 'scribd-failed',
]);

export function roomAlertReadKey(email: string): string {
  return email.trim() ? `${PREFIX}${email.trim().toLowerCase()}` : '';
}

/** A changed message is new even when it has the same underlying condition. */
export function roomAlertFingerprint(alert: RoomAlert): string {
  return JSON.stringify([alert.title, alert.detail, alert.level, alert.target]);
}

export function isRoomAlertRead(alert: RoomAlert, reads: ReadRoomAlerts): boolean {
  return reads[alert.id] === roomAlertFingerprint(alert);
}

export function loadRoomAlertReads(key: string): ReadRoomAlerts {
  if (!key || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > 20_000) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, value]) =>
      ALERT_IDS.has(id) && typeof value === 'string' && value.length <= 1_000,
    ));
  } catch {
    return {};
  }
}

export function saveRoomAlertReads(key: string, reads: ReadRoomAlerts): void {
  if (!key || typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify(reads)); } catch { /* unread state still works in memory */ }
}

/**
 * Only forget a read when a check actually confirms its condition cleared.
 * A failed or not-yet-loaded check is not evidence that a warning resolved.
 */
export function resolvedRoomAlertIds(
  data: AdminOverviewPayload,
  overviewCheckedAt: number | null,
  overviewError: string | null,
  scribd: ScribdSnapshot,
  panel: PanelLiveStatus | null,
): string[] {
  const resolved: string[] = [];
  if (overviewCheckedAt != null && !overviewError) {
    resolved.push('status');
    if (data.botServerLinked) resolved.push('bot-link');
    if (data.botReachable === true) {
      resolved.push('bot-unreachable');
      if (data.connected === true) resolved.push('whatsapp');
      if (data.diskBudgetMB != null && data.diskBudgetMB > 0 && data.diskUsedMB != null && data.diskUsedMB / data.diskBudgetMB < 0.85) {
        resolved.push('disk');
      }
    }
    if (data.scribdTokenConfigured === true) resolved.push('scribd-token');
    if (data.scribdSecureTransport === true) resolved.push('scribd-transport');
    if (data.whitelistSync === 'synced') resolved.push('number-sync');
  }
  if (panel && !panel.error && (panel.reachable === true || panel.configured === false)) {
    resolved.push('panel-status', 'panel-credentials');
    if (panel.configured === false || (panel.state !== 'unknown' && panel.state !== 'offline')) resolved.push('panel-offline');
    if (panel.configured === false || (panel.state !== 'unknown' && panel.state !== 'suspended')) resolved.push('panel-suspended');
  }
  if (scribd.status && !scribd.error) {
    resolved.push('scribd-offline');
    if (scribd.status.failed === 0) resolved.push('scribd-failed');
  }
  return resolved;
}
