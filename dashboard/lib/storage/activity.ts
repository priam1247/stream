import crypto from 'node:crypto';
import type { ActivityEvent } from '../types';
import { queryD1, requireD1 } from './d1';

export async function appendActivity(event: Omit<ActivityEvent, 'id' | 'createdAt'>): Promise<void> {
  const now = new Date().toISOString();
  const entry: ActivityEvent = {
    id: crypto.randomUUID(),
    category: event.category,
    action: event.action.slice(0, 100),
    actor: event.actor.trim().toLowerCase().slice(0, 160),
    outcome: event.outcome,
    detail: event.detail.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 200),
    createdAt: now,
  };
  await requireD1();
  await queryD1(
    `INSERT INTO portal_activity (id, category, action, actor, outcome, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.category, entry.action, entry.actor, entry.outcome, entry.detail, entry.createdAt],
  );
  // Bound retention so the history does not grow indefinitely.
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await queryD1(`DELETE FROM portal_activity WHERE created_at < ?`, [cutoff]);
  return;
}

export async function listRecentActivity(limit = 100): Promise<ActivityEvent[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 100));
  await requireD1();
  const rows = (await queryD1(
    `SELECT id, category, action, actor, outcome, detail, created_at
     FROM portal_activity ORDER BY created_at DESC, id DESC LIMIT ?`,
    [safeLimit],
  )) || [];
  return rows.map((row) => ({
    id: String(row.id),
    category: String(row.category) as ActivityEvent['category'],
    action: String(row.action),
    actor: String(row.actor),
    outcome: String(row.outcome) as ActivityEvent['outcome'],
    detail: String(row.detail || ''),
    createdAt: String(row.created_at),
  }));
}
