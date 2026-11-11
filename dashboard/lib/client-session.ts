import { AuthUser, UserQuota } from './types';

// The user chose to require sign-in after a full page reload or restored tab.
// Do not put this token in a cookie, localStorage, sessionStorage or a URL.
let sessionToken = '';

export function getSavedSessionToken(): string {
  if (typeof window === 'undefined') return '';
  return sessionToken;
}

export function setSavedSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  sessionToken = token;
}

export function clearSavedSessionToken(): void {
  if (typeof window === 'undefined') return;
  sessionToken = '';
}

export function authHeaders(): HeadersInit {
  const token = getSavedSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['x-session-token'] = token;
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchCurrentSession(): Promise<{
  user: AuthUser;
  quota: UserQuota | null;
} | null> {
  try {
    const token = getSavedSessionToken();
    // Never let a restored cookie or an old localStorage token resume a login.
    if (!token) return null;
    const res = await fetch('/api/auth/me', {
      headers: { 'x-session-token': token, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      clearSavedSessionToken();
      return null;
    }
    const data = await res.json();
    if (!data?.user) return null;
    return { user: data.user, quota: data.quota || null };
  } catch {
    return null;
  }
}

export async function performSignOut(): Promise<void> {
  clearSavedSessionToken();
}
