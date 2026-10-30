import { createHash } from 'node:crypto';
import { signSessionJwt, verifySessionJwt } from './jwt';

// A normal browser download cannot attach the in-memory Authorization header.
// This ticket can fetch only one named PDF, and is short-lived and cookie-scoped.
export const SCRIBD_DOWNLOAD_TICKET_SECONDS = 20;
export const SCRIBD_DOWNLOAD_COOKIE_PATH = '/api/scribd/file';
const PURPOSE = 'scribd-file-download';

export function scribdDownloadCookieName(filename: string): string {
  return `zafar_download_${createHash('sha256').update(filename).digest('hex').slice(0, 20)}`;
}

export function signScribdDownloadTicket(email: string, filename: string): string {
  return signSessionJwt({ sub: email, purpose: PURPOSE, file: filename }, SCRIBD_DOWNLOAD_TICKET_SECONDS);
}

export function verifyScribdDownloadTicket(token: string, filename: string): string | null {
  const claims = verifySessionJwt(token);
  if (!claims || claims.purpose !== PURPOSE || claims.file !== filename) return null;
  return claims.sub;
}
