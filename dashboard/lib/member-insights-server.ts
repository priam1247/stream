import { sessionBackupClaim } from './storage';
import { readAccountStatuses } from './whatsapp-accounts';
import type {
  ApprovedUser, BotHeartbeatRecord, ConfirmedMemberLink, MemberUsageDay,
  PersonalUsage, ServiceMemberUsage, WhatsAppAccountStatus,
} from './types';

const LINKED_STATES = new Set(['connected', 'connecting', 'paused']);
const DAY_MS = 86_400_000;
const MAX_SESSIONS = 101;
const MAX_DAYS = 14;
const MAX_COMMANDS = 64;
const COMMAND = /^[a-z0-9_-]{1,32}$/;
const SESSION = /^[a-f0-9]{24}$/;
const CLAIM = /^[a-f0-9]{64}$/;

function currentClaims(users: ApprovedUser[]): Map<string, string> {
  return new Map(users.map((user) => [user.number, sessionBackupClaim(user).token]));
}

/** Remember only a completed, generation- and owner-matched link. This is history,
 * not an authorization decision; approval still requires a fresh live session. */
export function mergeConfirmedLinks(
  previous: BotHeartbeatRecord | null,
  reported: WhatsAppAccountStatus[] | undefined,
  users: ApprovedUser[],
  observedAt = Date.now(),
  persisted: ConfirmedMemberLink[] = [],
): ConfirmedMemberLink[] {
  const claims = currentClaims(users);
  const links = new Map<string, ConfirmedMemberLink>();
  const put = (item: ConfirmedMemberLink) => {
    if (!item || !SESSION.test(item.sessionId || '') || !CLAIM.test(item.claimToken || '') ||
        claims.get(item.number) !== item.claimToken || !Number.isSafeInteger(item.observedAt) ||
        item.observedAt <= 0 || item.observedAt > Date.now() + 60_000) return;
    const old = links.get(item.number);
    if (old && old.observedAt > item.observedAt) return;
    const validLinkedAt = Number.isSafeInteger(item.linkedAt) && item.linkedAt! > 0 && item.linkedAt! <= Date.now() + 60_000 ? item.linkedAt : undefined;
    const linkedAt = validLinkedAt || (old?.sessionId === item.sessionId ? old.linkedAt : undefined);
    links.set(item.number, { number: item.number, sessionId: item.sessionId, claimToken: item.claimToken,
      observedAt: item.observedAt, ...(linkedAt ? { linkedAt } : {}) });
  };
  for (const item of persisted.slice(0, MAX_SESSIONS)) put(item);
  for (const item of (Array.isArray(previous?.confirmedLinks) ? previous.confirmedLinks : []).slice(0, MAX_SESSIONS)) put(item);
  const remember = (account: WhatsAppAccountStatus, at: number) => {
    if (!LINKED_STATES.has(account.state) || !account.sessionId || !account.claimToken ||
        claims.get(account.number) !== account.claimToken) return;
    put({ number: account.number, sessionId: account.sessionId, claimToken: account.claimToken,
      observedAt: at, ...(account.linkedAt ? { linkedAt: account.linkedAt } : {}) });
  };
  if (previous?.accounts) {
    for (const account of readAccountStatuses(previous.accounts) || []) remember(account, previous.lastSeenAt);
  }
  for (const account of reported || []) remember(account, observedAt);
  return [...links.values()].sort((a, b) => b.observedAt - a.observedAt).slice(0, MAX_SESSIONS);
}

/** Avoid writes for unchanged generations; timestamps alone are not a change. */
export function changedConfirmedLinks(links: ConfirmedMemberLink[], stored: ConfirmedMemberLink[] = []): ConfirmedMemberLink[] {
  const previous = new Map((Array.isArray(stored) ? stored : []).filter(Boolean).map((link) => [`${link.number}:${link.claimToken}`, link]));
  return links.filter((link) => {
    const old = previous.get(`${link.number}:${link.claimToken}`);
    return !old || old.sessionId !== link.sessionId || old.linkedAt !== link.linkedAt;
  });
}

function safeTimestamp(value: unknown, now: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now + 60_000
    ? Math.min(value, now) : undefined;
}

function safeDate(value: unknown, now: number): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return undefined;
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z');
  return timestamp <= today && timestamp >= today - (MAX_DAYS - 1) * DAY_MS ? value : undefined;
}

/** Accept bounded, content-free command counters, and bind each to the current claim. */
export function readServiceMemberUsage(value: unknown, users: ApprovedUser[], now = Date.now()): ServiceMemberUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const startedAt = safeTimestamp(raw.startedAt, now);
  if (!startedAt || !Array.isArray(raw.sessions)) return undefined;
  const claims = currentClaims(users);
  const sessions = new Map<string, ServiceMemberUsage['sessions'][number]>();
  for (const candidate of raw.sessions.slice(0, MAX_SESSIONS)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const number = String(item.number || '');
    const sessionId = String(item.sessionId || '');
    const claimToken = String(item.claimToken || '');
    if (!/^\d{7,15}$/.test(number) || !SESSION.test(sessionId) || !CLAIM.test(claimToken) || claims.get(number) !== claimToken || !Array.isArray(item.days)) continue;
    const days = new Map<string, MemberUsageDay>();
    for (const rawDay of item.days.slice(0, MAX_DAYS)) {
      if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) continue;
      const day = rawDay as Record<string, unknown>;
      const date = safeDate(day.date, now);
      if (!date || !day.commands || typeof day.commands !== 'object' || Array.isArray(day.commands)) continue;
      const commands: Record<string, number> = Object.create(null);
      for (const [name, count] of Object.entries(day.commands).slice(0, MAX_COMMANDS)) {
        if (COMMAND.test(name) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0 && count <= 1_000_000) commands[name] = count;
      }
      days.set(date, { date, commands });
    }
    const lastAt = safeTimestamp(item.lastAt, now);
    const lastCommand = typeof item.lastCommand === 'string' && COMMAND.test(item.lastCommand) ? item.lastCommand : undefined;
    sessions.set(`${number}:${sessionId}:${claimToken}`, {
      number, sessionId, claimToken, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      ...(lastAt && lastCommand ? { lastAt, lastCommand } : {}),
    });
  }
  return { startedAt, updatedAt: now, sessions: [...sessions.values()] };
}

/** Reduce the last signed sample to this account only; no claims or generations leave the server. */
export function personalInsights(heartbeat: BotHeartbeatRecord | null, users: ApprovedUser[], persisted: ConfirmedMemberLink[] = []): {
  confirmedLinks: { number: string; linkedAt?: number }[];
  personalUsage: PersonalUsage[] | null;
} {
  const links = mergeConfirmedLinks(heartbeat, undefined, users, heartbeat?.lastSeenAt, persisted);
  const confirmedLinks = links.map(({ number, linkedAt }) => ({ number, ...(linkedAt ? { linkedAt } : {}) }));
  const storedUsage = heartbeat?.memberUsage;
  const usage = storedUsage && readServiceMemberUsage(storedUsage, users);
  const updatedAt = safeTimestamp(storedUsage?.updatedAt, Date.now());
  if (!usage || !updatedAt) {
    return { confirmedLinks, personalUsage: null };
  }
  const claims = currentClaims(users);
  const personalUsage = users.map((user): PersonalUsage => {
    const link = links.find((item) => item.number === user.number);
    const days = new Map<string, Record<string, number>>();
    let lastAt = 0;
    let lastCommand = '';
    for (const item of usage.sessions) {
      if (item.number !== user.number || item.claimToken !== claims.get(user.number)) continue;
      for (const day of item.days || []) {
        const counts = days.get(day.date) || Object.create(null);
        for (const [name, count] of Object.entries(day.commands || {})) counts[name] = (counts[name] || 0) + count;
        days.set(day.date, counts);
      }
      if (item.lastAt && item.lastCommand && item.lastAt > lastAt) { lastAt = item.lastAt; lastCommand = item.lastCommand; }
    }
    return {
      number: user.number,
      trackedSince: Math.max(usage.startedAt, link?.linkedAt || 0),
      updatedAt,
      days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, commands]) => ({ date, commands })),
      ...(lastAt && lastCommand ? { lastAt, lastCommand } : {}),
    };
  });
  return { confirmedLinks, personalUsage };
}
