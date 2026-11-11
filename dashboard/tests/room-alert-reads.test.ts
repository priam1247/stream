import { afterEach, describe, expect, it } from 'vitest';
import { getRoomAlerts } from '../lib/control-room';
import { isRoomAlertRead, loadRoomAlertReads, resolvedRoomAlertIds, roomAlertFingerprint, roomAlertReadKey, saveRoomAlertReads } from '../lib/room-alert-reads';
import type { AdminOverviewPayload, PanelLiveStatus } from '../lib/types';

const overview: AdminOverviewPayload = {
  ok: true, adminEmail: '', botServerLinked: true, botReachable: true, connected: true, botEnabledForMembers: true, storageEngine: 'cloudflare-d1',
  botNumber: null, users: [], members: [], whitelistSync: 'pending',
};

afterEach(() => localStorage.clear());

describe('unread health alerts', () => {
  it('keeps read state separate for each owner on this device', () => {
    const alert = getRoomAlerts(overview, Date.now(), null).find((item) => item.id === 'number-sync')!;
    const first = roomAlertReadKey('OWNER@example.com');
    const second = roomAlertReadKey('other@example.com');
    saveRoomAlertReads(first, { [alert.id]: roomAlertFingerprint(alert) });
    expect(isRoomAlertRead(alert, loadRoomAlertReads(first))).toBe(true);
    expect(isRoomAlertRead(alert, loadRoomAlertReads(second))).toBe(false);
    expect(isRoomAlertRead({ ...alert, title: 'Updated warning' }, loadRoomAlertReads(first))).toBe(false);
  });

  it('ignores corrupt and unexpected stored entries', () => {
    const key = roomAlertReadKey('owner@example.com');
    localStorage.setItem(key, '{broken');
    expect(loadRoomAlertReads(key)).toEqual({});
    localStorage.setItem(key, JSON.stringify({ 'unknown-alert': 'ignored', 'number-sync': 42 }));
    expect(loadRoomAlertReads(key)).toEqual({});
  });

  it('does not mistake unknown or unavailable status for resolution', () => {
    const now = Date.now();
    const panel: PanelLiveStatus = { configured: true, reachable: false, state: 'unknown', error: 'Unavailable', checkedAt: now };
    const unknown = { ...overview, botReachable: false, connected: null, whitelistSync: 'unknown' as const };
    const unresolved = resolvedRoomAlertIds(unknown, now, null, panel);
    for (const id of ['number-sync', 'bot-unreachable', 'whatsapp', 'panel-offline']) {
      expect(unresolved).not.toContain(id);
    }
    const healthy = resolvedRoomAlertIds({ ...overview, whitelistSync: 'synced' }, now, null,
      { configured: true, reachable: true, state: 'running', error: null, checkedAt: now });
    expect(healthy).toEqual(expect.arrayContaining(['number-sync', 'bot-unreachable', 'whatsapp', 'panel-offline']));
  });
});
