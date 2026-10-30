import type { WhatsAppAccountState, WhatsAppAccountStatus } from './types';

const STATES = new Set<WhatsAppAccountState>(['connected', 'connecting', 'awaiting_link', 'expired', 'logged_out', 'paused']);

/** Undefined means the running service did not report individual accounts. */
export function readAccountStatuses(value: unknown): WhatsAppAccountStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const accounts = new Map<string, WhatsAppAccountStatus>();
  for (const raw of value.slice(0, 101)) {
    if (!raw || typeof raw !== 'object') continue;
    const number = String(raw.number || '');
    const state = String(raw.state || '') as WhatsAppAccountState;
    if (/^\d{7,15}$/.test(number) && STATES.has(state)) {
      const sessionId = typeof raw.sessionId === 'string' && /^[a-f0-9]{24}$/.test(raw.sessionId) ? raw.sessionId : undefined;
      const linkedAt = typeof raw.linkedAt === 'number' && Number.isSafeInteger(raw.linkedAt) && raw.linkedAt > 0 && raw.linkedAt <= Date.now() + 60_000 ? raw.linkedAt : undefined;
      accounts.set(number, { number, state, ...(sessionId ? { sessionId } : {}), ...(linkedAt ? { linkedAt } : {}) });
    }
  }
  return [...accounts.values()];
}

// Historical activity and older servers may still return the former name.
export function serviceText(value: string): string {
  return value.replace(/zafar\s*bot/gi, 'WhatsApp service').replace(/zafar/gi, 'WhatsApp').replace(/\bbot\b/gi, 'service');
}

export function accountStatusLabel(accounts: WhatsAppAccountStatus[] | null | undefined, number: string): string {
  if (!accounts) return 'Link status unknown';
  const state = accounts.find((account) => account.number === number)?.state;
  switch (state) {
    case 'connected': return 'Linked and connected';
    case 'connecting': return 'Linked · reconnecting';
    case 'awaiting_link': return 'Waiting for linking';
    case 'expired': return 'Code expired · request another';
    case 'logged_out': return 'Unlinked · request a new code';
    case 'paused': return 'Linked · access paused';
    default: return 'Not linked';
  }
}
