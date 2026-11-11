import type { ApprovedUser, ConfirmedMemberLink } from '../types';
import { sessionBackupClaim } from './backups';
import { queryD1, requireD1 } from './d1';

// Link evidence is stored per ownership claim, separately from the heartbeat.
// Independent rows cannot overwrite another member's link during concurrent polls.
const MEMBER_LINK_PREFIX = 'member_confirmed_link:';

function memberLinkKey(number: string, claimToken: string): string {
  return `${MEMBER_LINK_PREFIX}${number}:${claimToken}`;
}

export async function listConfirmedMemberLinks(users: ApprovedUser[]): Promise<ConfirmedMemberLink[]> {
  const claims = new Map(users.slice(0, 101).map((user) => [memberLinkKey(user.number, sessionBackupClaim(user).token), user]));
  if (!claims.size) return [];
  const values: { key: string; value: string }[] = [];
  await requireD1();
  const keys = [...claims.keys()];
  for (let i = 0; i < keys.length; i += 80) {
    const batch = keys.slice(i, i + 80);
    const rows = await queryD1(`SELECT key, value FROM portal_settings WHERE key IN (${batch.map(() => '?').join(', ')})`, batch);
    values.push(...(rows || []).map((row) => ({ key: String(row.key), value: String(row.value) })));
  }
  const now = Date.now();
  return values.flatMap(({ key, value }) => {
    try {
      const link = JSON.parse(value) as ConfirmedMemberLink;
      const user = claims.get(key);
      if (!user || link.number !== user.number || link.claimToken !== sessionBackupClaim(user).token ||
          key !== memberLinkKey(link.number, link.claimToken) || !/^[a-f0-9]{24}$/.test(link.sessionId) ||
          !Number.isSafeInteger(link.observedAt) || link.observedAt <= 0 || link.observedAt > now + 60_000) return [];
      const linkedAt = Number.isSafeInteger(link.linkedAt) && link.linkedAt! > 0 && link.linkedAt! <= now + 60_000 ? link.linkedAt : undefined;
      return [{ number: link.number, sessionId: link.sessionId, claimToken: link.claimToken, observedAt: link.observedAt, ...(linkedAt ? { linkedAt } : {}) }];
    } catch { return []; }
  });
}

/** Save only completed links while the same owner still holds the claim. */

/** Save only completed links while the same owner still holds the claim. */
export async function saveConfirmedMemberLinks(links: ConfirmedMemberLink[], users: ApprovedUser[]): Promise<void> {
  const byNumber = new Map(users.map((user) => [user.number, user]));
  const unique = new Map<string, { link: ConfirmedMemberLink; user: ApprovedUser }>();
  const now = Date.now();
  for (const link of links.slice(0, 101)) {
    const user = byNumber.get(link.number);
    if (!user || sessionBackupClaim(user).token !== link.claimToken || !/^[a-f0-9]{24}$/.test(link.sessionId) ||
        !Number.isSafeInteger(link.observedAt) || link.observedAt <= 0 || link.observedAt > now + 60_000) continue;
    const linkedAt = Number.isSafeInteger(link.linkedAt) && link.linkedAt! > 0 && link.linkedAt! <= now + 60_000 ? link.linkedAt : undefined;
    const clean = { number: link.number, sessionId: link.sessionId, claimToken: link.claimToken, observedAt: link.observedAt, ...(linkedAt ? { linkedAt } : {}) };
    const key = memberLinkKey(link.number, link.claimToken);
    if (!unique.has(key) || unique.get(key)!.link.observedAt <= clean.observedAt) unique.set(key, { link: clean, user });
  }
  const entries = [...unique.entries()];
  if (!entries.length) return;
  await requireD1();
  // Each row's claim is checked at the SQL snapshot. A delayed observation
  // cannot recreate evidence after a number is unlinked or transferred.
  for (let i = 0; i < entries.length; i += 16) {
    const batch = entries.slice(i, i + 16);
    const select = batch.map(() => `SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM portal_whatsapp_access
      WHERE number = ? AND COALESCE(claim_id, '') = ? AND lower(COALESCE(added_by, '')) = ?)`).join(' UNION ALL ');
    const params = batch.flatMap(([key, { link, user }]) => {
      const identity = sessionBackupClaim(user).identity;
      return [key, JSON.stringify(link), new Date(link.observedAt).toISOString(), user.number, identity.key, identity.owner];
    });
    await queryD1(`INSERT INTO portal_settings (key, value, updated_at) ${select}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= portal_settings.updated_at`, params);
  }
  return;
}

export async function deleteConfirmedMemberLink(number: string, claimToken: string): Promise<void> {
  await requireD1();
  await queryD1(`DELETE FROM portal_settings WHERE key = ?`, [memberLinkKey(number, claimToken)]);
}
