import { describe, expect, it } from 'vitest';
import { getRoomAlerts } from '../lib/control-room';
import type { AdminOverviewPayload, PanelLiveStatus } from '../lib/types';

const overview: AdminOverviewPayload = {
  ok: true, adminEmail: '', botServerLinked: true, botReachable: true, connected: true,
  botApiUrl: '', hasBotToken: false, botEnabledForMembers: true, storageEngine: 'cloudflare-d1',
  botNumber: null, users: [], members: [],
};

describe('workspace hosting alerts', () => {
  it('makes rejected panel credentials actionable without calling WhatsApp offline', () => {
    const panel: PanelLiveStatus = { configured: true, reachable: true, state: 'unknown', error: 'Panel credentials were rejected.', checkedAt: Date.now() };
    const alerts = getRoomAlerts(overview, Date.now(), null, panel);
    expect(alerts).toContainEqual(expect.objectContaining({ id: 'panel-credentials', target: { tab: 'server', page: 'hosting' } }));
    expect(alerts.some((alert) => alert.id === 'bot-unreachable' || alert.id === 'whatsapp' || alert.id === 'panel-offline')).toBe(false);
  });

  it('does not infer offline when the hosting status check fails', () => {
    const panel: PanelLiveStatus = { configured: null, reachable: false, state: 'unknown', error: 'Panel status could not be checked.', checkedAt: Date.now() };
    const alerts = getRoomAlerts(overview, Date.now(), null, panel);
    expect(alerts).toContainEqual(expect.objectContaining({ id: 'panel-status', target: { tab: 'server', page: 'service' } }));
    expect(alerts.some((alert) => alert.id === 'panel-offline')).toBe(false);
  });
});
