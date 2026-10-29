import { appendActivity } from './storage';
import type { ActivityEvent } from './types';

/** Record a server-side event without exposing secrets or breaking the action if logging fails. */
export async function recordActivity(event: Omit<ActivityEvent, 'id' | 'createdAt'>): Promise<void> {
  try {
    await appendActivity(event);
  } catch (error) {
    // Do not put the action payload, upstream response or credentials in logs.
    console.error('Could not record control-room activity.', error instanceof Error ? error.name : 'StorageError');
  }
}

export function maskedNumber(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits ? `Number ending ${digits.slice(-4)}` : 'WhatsApp number';
}
