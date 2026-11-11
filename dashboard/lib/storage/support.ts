import { queryD1, requireD1 } from './d1';

export interface SupportMessage { id: number; memberEmail: string; role: 'member' | 'admin'; text: string; createdAt: number }

export interface SupportThread { email: string; latestAt: number; preview: string; unread: number }

function supportMessage(row: Record<string, unknown>): SupportMessage {
  return { id: Number(row.id), memberEmail: String(row.member_email), role: row.sender_role === 'admin' ? 'admin' : 'member', text: String(row.body), createdAt: Number(row.created_at) };
}

/** Atomic per-conversation throttling prevents a fast client bypassing the UI. */

/** Atomic per-conversation throttling prevents a fast client bypassing the UI. */
export async function addSupportMessage(email: string, role: 'member' | 'admin', text: string, now = Date.now()): Promise<SupportMessage | null> {
  const owner = email.trim().toLowerCase();
  if (!owner || !text || text.length > 2000) throw new Error('Invalid message.');
  await requireD1();
  const rows = await queryD1(`INSERT INTO portal_support_messages (member_email, sender_role, body, created_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM portal_support_messages
      WHERE member_email = ? AND sender_role = ? AND created_at > ?) RETURNING *`,
    [owner, role, text, now, owner, role, now - 5000]);
  return rows?.length ? supportMessage(rows[0]) : null;
}

export async function listSupportMessages(email: string, viewer: 'member' | 'admin', markRead = true): Promise<SupportMessage[]> {
  const owner = email.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(`SELECT * FROM portal_support_messages WHERE member_email = ? ORDER BY id DESC LIMIT 200`, [owner]);
  const messages = (rows || []).map(supportMessage).reverse();
  const lastId = messages[messages.length - 1]?.id || 0;
  if (markRead && lastId) {
    const column = viewer === 'admin' ? 'admin_seen_id' : 'member_seen_id';
    await queryD1(`INSERT INTO portal_support_reads (member_email, ${column}) VALUES (?, ?)
      ON CONFLICT(member_email) DO UPDATE SET ${column} = MAX(${column}, excluded.${column})`, [owner, lastId]);
  }
  return messages;
}

export async function listSupportThreads(): Promise<SupportThread[]> {
  await requireD1();
  const rows = await queryD1(`SELECT m.member_email,
    MAX(m.created_at) AS latest_at,
    (SELECT body FROM portal_support_messages x WHERE x.member_email = m.member_email ORDER BY x.id DESC LIMIT 1) AS preview,
    SUM(CASE WHEN m.sender_role = 'member' AND m.id > COALESCE(r.admin_seen_id, 0) THEN 1 ELSE 0 END) AS unread
    FROM portal_support_messages m LEFT JOIN portal_support_reads r ON r.member_email = m.member_email
    GROUP BY m.member_email ORDER BY latest_at DESC LIMIT 200`);
  return (rows || []).map((row) => ({ email: String(row.member_email), latestAt: Number(row.latest_at), preview: String(row.preview), unread: Number(row.unread) }));
}

export async function countMemberSupportUnread(email: string): Promise<number> {
  const owner = email.trim().toLowerCase();
  await requireD1();
  const rows = await queryD1(`SELECT COUNT(*) AS total FROM portal_support_messages m LEFT JOIN portal_support_reads r ON r.member_email = m.member_email
    WHERE m.member_email = ? AND m.sender_role = 'admin' AND m.id > COALESCE(r.member_seen_id, 0)`, [owner]);
  return Number(rows?.[0]?.total) || 0;
}
