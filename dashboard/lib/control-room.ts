import type { AdminOverviewPayload, PanelLiveStatus } from './types';
import type { ScribdStatusPayload } from './scribd-types';

export type OwnerTab = 'overview' | 'server' | 'scribd' | 'members' | 'activity' | 'support';
export type WhatsAppPage = 'numbers' | 'commands' | 'service' | 'power' | 'sync' | 'hosting';
export type ScribdPage = 'search' | 'queue' | 'files';
export type ActivityPage = 'alerts' | 'history';
export type RoomTarget =
  | { tab: 'server'; page?: WhatsAppPage }
  | { tab: 'scribd'; page?: ScribdPage }
  | { tab: 'activity'; page?: ActivityPage }
  | { tab: 'overview' | 'members' | 'support' };
export interface ScribdSnapshot {
  status: ScribdStatusPayload | null;
  error: string | null;
  checkedAt: number | null;
}
export interface RoomAlert {
  id: string;
  title: string;
  detail: string;
  target: RoomTarget;
  level: 'warning' | 'danger';
}

/** Derive alerts only from observations we actually have, never guessed health. */
export function getRoomAlerts(
  data: AdminOverviewPayload,
  overviewCheckedAt: number | null,
  overviewError: string | null,
  scribd: ScribdSnapshot,
  panel: PanelLiveStatus | null = null,
): RoomAlert[] {
  const alerts: RoomAlert[] = [];
  const linkedPending = data.users.filter((user) => user.approval === 'pending' && data.accounts?.some((account) => account.number === user.number && account.sessionId && account.claimCurrent === true && ['connected', 'connecting', 'paused'].includes(account.state))).length;
  if (linkedPending) {
    alerts.push({ id: 'link-approvals', title: `${linkedPending} link ${linkedPending === 1 ? 'request' : 'requests'} awaiting approval`, detail: 'A member has linked WhatsApp and is waiting for your decision.', target: { tab: 'members' }, level: 'warning' });
  }
  if (panel?.state === 'suspended') {
    alerts.push({ id: 'panel-suspended', title: 'Hosting server suspended', detail: 'The hosting panel reports this server is suspended. Review the panel for details.', target: { tab: 'server', page: 'service' }, level: 'danger' });
  } else if (panel?.state === 'offline') {
    alerts.push({ id: 'panel-offline', title: 'Hosting server is offline', detail: 'The hosting panel reports the configured WhatsApp server is offline.', target: { tab: 'server', page: 'service' }, level: 'warning' });
  } else if (panel?.error) {
    const rejected = /credentials were rejected/i.test(panel.error);
    alerts.push(rejected
      ? { id: 'panel-credentials', title: 'Hosting credentials rejected', detail: 'Check the saved panel credentials. This does not mean WhatsApp is offline.', target: { tab: 'server', page: 'hosting' }, level: 'warning' }
      : { id: 'panel-status', title: 'Hosting status unavailable', detail: 'The dashboard could not confirm the hosting server status.', target: { tab: 'server', page: 'service' }, level: 'warning' });
  }
  if (overviewError) {
    alerts.push({ id: 'status', title: 'Service status unavailable', detail: 'The dashboard could not refresh the service status. Check the service connection.', target: { tab: 'server', page: 'service' }, level: 'danger' });
  } else if (overviewCheckedAt != null) {
    if (!data.botServerLinked) {
      alerts.push({ id: 'bot-link', title: 'Service connection not configured', detail: 'Connect the service or wait for its first heartbeat.', target: { tab: 'server', page: 'sync' }, level: 'warning' });
    } else if (data.botReachable === false) {
      alerts.push({ id: 'bot-unreachable', title: 'Service is not reporting', detail: 'The last check could not reach the service. Review its connection and heartbeat.', target: { tab: 'server', page: 'service' }, level: 'danger' });
    } else if (data.botReachable && data.connected === false) {
      alerts.push({ id: 'whatsapp', title: 'WhatsApp is disconnected', detail: 'The service is reachable, but its WhatsApp connection is not active.', target: { tab: 'server', page: 'numbers' }, level: 'warning' });
    }
    if (data.scribdTokenConfigured === false) {
      alerts.push({ id: 'scribd-token', title: 'Scribd direct access may be open', detail: 'Dashboard permissions do not protect the service port. Configure a server token or restrict its network access.', target: { tab: 'scribd' }, level: 'warning' });
    }
    if (data.scribdSecureTransport === false) {
      alerts.push({ id: 'scribd-transport', title: 'Scribd connection is unencrypted', detail: 'Use HTTPS or a trusted private network to protect library traffic and any token.', target: { tab: 'scribd' }, level: 'warning' });
    }
    if (data.whitelistSync === 'pending') {
      alerts.push({ id: 'number-sync', title: 'Number list awaiting sync', detail: 'The service has not yet reported the latest dashboard list.', target: { tab: 'server', page: 'numbers' }, level: 'warning' });
    }
    if (data.botReachable && data.diskUsedMB != null && data.diskBudgetMB != null && data.diskBudgetMB > 0 && data.diskUsedMB / data.diskBudgetMB >= 0.85) {
      alerts.push({ id: 'disk', title: 'Storage is running low', detail: 'The service reports at least 85% of its disk budget in use.', target: { tab: 'server', page: 'service' }, level: 'warning' });
    }
  }
  if (scribd.error) {
    alerts.push({ id: 'scribd-offline', title: 'Scribd status unavailable', detail: 'The last check could not confirm service status. Open Scribd for details.', target: { tab: 'scribd' }, level: 'danger' });
  } else if (scribd.status && scribd.status.failed > 0) {
    alerts.push({ id: 'scribd-failed', title: `${scribd.status.failed} failed Scribd ${scribd.status.failed === 1 ? 'job' : 'jobs'}`, detail: 'There are failed items in the shared queue history. Open Scribd for details.', target: { tab: 'scribd', page: 'queue' }, level: 'warning' });
  }
  return alerts;
}

export function formatCheckedTime(timestamp: number | null): string {
  if (timestamp == null) return 'Not checked yet';
  return `Checked ${new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
