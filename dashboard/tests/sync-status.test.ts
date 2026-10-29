// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { whitelistVersionFor } from '../lib/storage';
import { whitelistSyncState } from '../lib/sync-status';

const users = [{ number: '265991234567', label: 'Phone', enabled: true }];
const version = whitelistVersionFor(users, true);

describe('bot-reported whitelist sync', () => {
  it('compares the latest canonical list to the version in a fresh heartbeat', () => {
    const live = { connectionMode: 'heartbeat', reachable: true, whitelistVersion: version };
    expect(whitelistSyncState(live, users, true)).toBe('synced');
    expect(whitelistSyncState(live, [{ ...users[0], enabled: false }], true)).toBe('pending');
    expect(whitelistSyncState(live, users, false)).toBe('pending');
  });
  it('does not claim synchronization without a fresh, versioned heartbeat', () => {
    expect(whitelistSyncState({ connectionMode: 'heartbeat', reachable: false, whitelistVersion: version }, users, true)).toBe('unknown');
    expect(whitelistSyncState({ connectionMode: 'heartbeat', reachable: true }, users, true)).toBe('unknown');
    expect(whitelistSyncState({ connectionMode: 'direct', reachable: true, whitelistVersion: version }, users, true)).toBe('unknown');
  });
});
