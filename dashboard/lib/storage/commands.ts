import crypto from 'node:crypto';
import type { BotCommandRecord } from '../types';
import { setFastPollWindow } from './bot';
import { queryD1, requireD1 } from './d1';

function mapD1BotCommand(row: Record<string, unknown>): BotCommandRecord {
  let payload: Record<string, unknown> = {};
  let result: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(String(row.payload_json || '{}'));
  } catch {
    payload = {};
  }
  if (row.result_json) {
    try {
      result = JSON.parse(String(row.result_json));
    } catch {
      result = null;
    }
  }
  return {
    id: String(row.id),
    type: String(row.type) as BotCommandRecord['type'],
    payload,
    status: String(row.status || 'pending') as BotCommandRecord['status'],
    result,
    error: row.error_text ? String(row.error_text) : null,
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
  };
}

export async function enqueueBotCommand(params: {
  type: Extract<BotCommandRecord['type'], 'pair' | 'unlink'>;
  payload: Record<string, unknown>;
  requestedBy?: string;
  ttlMs?: number;
}): Promise<BotCommandRecord> {
  const now = Date.now();
  const cmd: BotCommandRecord = {
    id: `cmd_${now.toString(36)}_${crypto.randomBytes(6).toString('hex')}`,
    type: params.type,
    payload: params.payload,
    status: 'pending',
    result: null,
    error: null,
    requestedBy: params.requestedBy,
    createdAt: now,
    expiresAt: now + (params.ttlMs || 60_000),
  };

  await requireD1();
  await queryD1(
    `DELETE FROM portal_bot_commands WHERE expires_at < ?`,
    [now - 300_000],
  );
  await queryD1(
    `INSERT INTO portal_bot_commands
     (id, type, payload_json, status, result_json, error_text, requested_by, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)`,
    [
      cmd.id,
      cmd.type,
      JSON.stringify(cmd.payload),
      cmd.requestedBy || null,
      cmd.createdAt,
      cmd.expiresAt,
    ],
  );

  await setFastPollWindow(60_000);
  return cmd;
}

/** Recover an accepted request after a refresh without exposing another member's code. */

/** Recover an accepted request after a refresh without exposing another member's code. */
export async function getLatestPairCommand(number: string, requestedBy: string, since: number): Promise<BotCommandRecord | null> {
  const owner = requestedBy.toLowerCase();
  await requireD1();
  const rows = await queryD1(
    `SELECT * FROM portal_bot_commands WHERE type = 'pair' AND lower(requested_by) = ?
     AND json_extract(payload_json, '$.number') = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`, [owner, number, since],
  );
  return rows?.length ? mapD1BotCommand(rows[0]) : null;
}

/** Direct responses also get a short-lived recovery record, never a queue entry. */

/** Direct responses also get a short-lived recovery record, never a queue entry. */
export async function saveCompletedPairResult(params: {
  number: string; requestedBy: string; createdAt: number; code: string; issuedAt: number; expiresInSeconds: number;
}): Promise<void> {
  const result = JSON.stringify({ code: params.code, issuedAt: params.issuedAt,
    expiresInSeconds: params.expiresInSeconds, _dashboardReceivedAt: Date.now() });
  const id = `pair_${params.createdAt.toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const expiresAt = params.createdAt + 90_000;
  await requireD1();
  await queryD1(`DELETE FROM portal_bot_commands WHERE expires_at < ?`, [Date.now() - 300_000]);
  await queryD1(
    `INSERT INTO portal_bot_commands (id, type, payload_json, status, result_json, error_text, requested_by, created_at, expires_at)
     VALUES (?, 'pair', ?, 'completed', ?, NULL, ?, ?, ?)`,
    [id, JSON.stringify({ number: params.number }), result, params.requestedBy.toLowerCase(), params.createdAt, expiresAt],
  );
  return;
}

export async function claimPendingBotCommands(): Promise<BotCommandRecord[]> {
  const now = Date.now();

  await requireD1();
  // Claim once under overlapping polls. Never dispatch old queued power
  // requests to a service that may still have a previous hosting target.
  const rows = await queryD1(`UPDATE portal_bot_commands SET status = 'claimed'
    WHERE id IN (SELECT id FROM portal_bot_commands WHERE status = 'pending' AND expires_at >= ?
      AND type IN ('pair', 'unlink') ORDER BY created_at ASC LIMIT 10) AND status = 'pending' RETURNING *`, [now]);
  return (rows || []).map(mapD1BotCommand);
}

/** Return only this request's undelivered claims to the queue if building a
 * response fails. A completed/expired command is never made pending again. */

/** Return only this request's undelivered claims to the queue if building a
 * response fails. A completed/expired command is never made pending again. */
export async function releaseClaimedBotCommands(ids: string[]): Promise<void> {
  const safe = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 100))];
  if (!safe.length) return;
  const now = Date.now();
  await requireD1();
  for (let i = 0; i < safe.length; i += 80) {
    const batch = safe.slice(i, i + 80);
    await queryD1(`UPDATE portal_bot_commands SET status = 'pending' WHERE status = 'claimed' AND expires_at >= ? AND id IN (${batch.map(() => '?').join(', ')})`, [now, ...batch]);
  }
  return;
}

export async function completeBotCommand(params: {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}): Promise<void> {
  const status: BotCommandRecord['status'] = params.ok ? 'completed' : 'failed';
  // Record receipt on the dashboard clock once. It is a fixed upper bound for
  // checking a service-provided issuance timestamp on subsequent polls.
  const result = params.result ? { ...params.result, _dashboardReceivedAt: Date.now() } : null;
  const resultJson = result ? JSON.stringify(result) : null;
  const errorText = params.error ? String(params.error).slice(0, 400) : null;

  await requireD1();
  await queryD1(
    `UPDATE portal_bot_commands
     SET status = ?, result_json = ?, error_text = ?
     WHERE id = ? AND status IN ('pending', 'claimed')`,
    [status, resultJson, errorText, params.id],
  );
  return;
}

export async function getBotCommandById(
  id: string,
): Promise<BotCommandRecord | null> {
  await requireD1();
  const rows = await queryD1(
    `SELECT * FROM portal_bot_commands WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows || rows.length === 0) return null;
  return mapD1BotCommand(rows[0]);
}

// ---------------------------------------------------------------------------
// Owner activity history. Never put credentials, pairing codes or PDF contents
// in these records. D1 is durable; the disk fallback is for local/self-hosting.
// ---------------------------------------------------------------------------
