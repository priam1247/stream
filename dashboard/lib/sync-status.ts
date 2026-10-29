import { whitelistVersionFor } from './storage';
import type { ApprovedUser, WhitelistSyncState } from './types';

/** A matching heartbeat confirms the bot reported the current list version.
 * Direct connections and stale or older heartbeats cannot confirm the snapshot. */
export function whitelistSyncState(
  live: { connectionMode: string; reachable: boolean; whitelistVersion?: string | null },
  users: ApprovedUser[],
  botEnabledForMembers: boolean,
): WhitelistSyncState {
  if (live.connectionMode !== 'heartbeat' || !live.reachable || !live.whitelistVersion) return 'unknown';
  return live.whitelistVersion === whitelistVersionFor(users, botEnabledForMembers) ? 'synced' : 'pending';
}
