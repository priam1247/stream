import type { AdminOverviewPayload, PanelLiveStatus } from './types';
import type { ScribdStatusPayload } from './scribd-types';

export type OwnerTab = 'overview' | 'server' | 'scribd' | 'members' | 'activity';
export interface ScribdSnapshot {
  status: ScribdStatusPayload | null;
  error: string | null;
  checkedAt: number | null;
}
export interface RoomAlert {
  id: string;
  title: string;
  detail: string;
  target: OwnerTab;
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
  if (panel?.state === 'suspended') {
    alerts.push({ id: 'panel-suspended', title: 'Hosting server suspended', detail: 'The hosting panel reports this server is suspended. Review the panel for details.', target: 'server', level: 'danger' });
  } else if (panel?.state === 'offline') {
    alerts.push({ id: 'panel-offline', title: 'Hosting server is offline', detail: 'The hosting panel reports the configured bot server is offline.', target: 'server', level: 'warning' });
  }
  if (overviewError) {
    alerts.push({ id: 'status', title: 'Bot status unavailable', detail: 'The dashboard could not refresh the bot status. Check the bot connection.', target: 'server', level: 'danger' });
  } else if (overviewCheckedAt != null) {
    if (!data.botServerLinked) {
      alerts.push({ id: 'bot-link', title: 'Bot connection not configured', detail: 'Connect the bot or wait for its first heartbeat.', target: 'server', level: 'warning' });
    } else if (data.botReachable === false) {
      alerts.push({ id: 'bot-unreachable', title: 'Bot is not reporting', detail: 'The last check could not reach the bot. Review its connection and heartbeat.', target: 'server', level: 'danger' });
    } else if (data.botReachable && data.connected === false) {
      alerts.push({ id: 'whatsapp', title: 'WhatsApp is disconnected', detail: 'The bot is reachable, but its WhatsApp connection is not active.', target: 'server', level: 'warning' });
    }
    if (data.scribdTokenConfigured === false) {
      alerts.push({ id: 'scribd-token', title: 'Scribd direct access may be open', detail: 'Dashboard permissions do not protect the service port. Configure a server token or restrict its network access.', target: 'scribd', level: 'warning' });
    }
    if (data.scribdSecureTransport === false) {
      alerts.push({ id: 'scribd-transport', title: 'Scribd connection is unencrypted', detail: 'Use HTTPS or a trusted private network to protect library traffic and any token.', target: 'scribd', level: 'warning' });
    }
    if (data.whitelistSync === 'pending') {
      alerts.push({ id: 'number-sync', title: 'Number list awaiting sync', detail: 'The bot has not yet reported the latest dashboard list.', target: 'server', level: 'warning' });
    }
    if (data.botReachable && data.diskUsedMB != null && data.diskBudgetMB != null && data.diskBudgetMB > 0 && data.diskUsedMB / data.diskBudgetMB >= 0.85) {
      alerts.push({ id: 'disk', title: 'Storage is running low', detail: 'The bot reports at least 85% of its disk budget in use.', target: 'server', level: 'warning' });
    }
  }
  if (scribd.error) {
    alerts.push({ id: 'scribd-offline', title: 'Scribd status unavailable', detail: 'The last check could not confirm service status. Open Scribd for details.', target: 'scribd', level: 'danger' });
  } else if (scribd.status && scribd.status.failed > 0) {
    alerts.push({ id: 'scribd-failed', title: `${scribd.status.failed} failed Scribd ${scribd.status.failed === 1 ? 'job' : 'jobs'}`, detail: 'There are failed items in the shared queue history. Open Scribd for details.', target: 'scribd', level: 'warning' });
  }
  return alerts;
}

export function formatCheckedTime(timestamp: number | null): string {
  if (timestamp == null) return 'Not checked yet';
  return `Checked ${new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
