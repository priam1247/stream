/**
 * Server-side client for the Scribd download panel (`tools/scribd_download.py`).
 *
 * This file only ever runs on the server. The browser talks to
 * `/api/scribd/*` on this dashboard, and this module talks to the panel, so:
 *   - the panel key never reaches the page,
 *   - there is no CORS to configure (the browser sees one origin: this one),
 *   - an `http://` panel inside an `https://` dashboard is not mixed content,
 *     because the request is made by the server, not by the browser.
 *
 * Where the panel is and what its key is comes from `getScribdConnectionConfig()`
 * — environment variables by default, overridable from the Scribd tab (which
 * saves to Cloudflare D1, exactly like the Pterodactyl panel settings):
 *   SCRIBD_PANEL_URL   e.g. http://195.123.189.187:25811
 *   SCRIBD_PANEL_KEY   the panel's PANEL_KEY, if it was locked
 */

import type {
  ScribdFile,
  ScribdFindPayload,
  ScribdPanelHealth,
  ScribdPanelStatus,
} from './scribd-types';
import {
  DEFAULT_SCRIBD_PANEL_URL,
  getScribdConnectionConfig,
} from './storage';

const DEFAULT_PANEL_URL = DEFAULT_SCRIBD_PANEL_URL;
const PANEL_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 120_000;

export type PanelResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: string;
      /** the panel's own JSON for a refusal (a 409 carries `quiet` seconds) */
      extra?: Record<string, unknown>;
    };

export interface ScribdPanelConfig {
  baseUrl: string;
  key: string;
}

/**
 * Where the panel can be reached *by the browser*, when it is published over
 * HTTPS (a Cloudflare Tunnel in front of port 25811, for example).
 *
 * The dashboard proxies every byte through its own functions, which is fine
 * until a 150 MB book meets a Vercel function's time limit. With this set, the
 * Save link points at the panel itself — the browser holds the panel cookie
 * from opening `/?key=…` once — so the file never passes through Vercel.
 */
export function scribdPublicUrl(): string {
  const raw = (process.env.SCRIBD_PUBLIC_URL || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';   // never mixed content
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** One panel address, cleaned so a pasted link still works. */
export function cleanPanelUrl(raw: string): string {
  try {
    const parsed = new URL((raw || DEFAULT_PANEL_URL).trim());
    // A pasted panel link often includes ?key=… or a trailing slash.
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_PANEL_URL;
  }
}

/** The live panel address and key: saved setting first, environment second. */
export async function scribdPanelConfig(): Promise<ScribdPanelConfig> {
  const saved = await getScribdConnectionConfig();
  return {
    baseUrl: cleanPanelUrl(saved.panelUrl),
    key: (saved.panelKey || '').trim(),
  };
}

function explainPanelStatus(status: number): string {
  if (status === 401) {
    return 'The Scribd panel is locked and its key is missing or wrong. Put the panel\'s PANEL_KEY in Panel settings.';
  }
  if (status === 404) {
    return 'The Scribd panel did not recognise that route. Update tools/scribd_download.py to v2.13 or newer (the reset route is new in 2.13).';
  }
  if (status === 409) {
    return 'A download is already running on the panel. Wait for it to finish.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return `The Scribd panel answered HTTP ${status} — it is up, but the page behind it did not answer.`;
  }
  return `The Scribd panel refused that request (HTTP ${status}).`;
}

function explainNetworkError(err: unknown, baseUrl: string): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/abort|timeout|timed out/i.test(text)) {
    return `The Scribd panel at ${baseUrl} did not answer within ${Math.round(
      PANEL_TIMEOUT_MS / 1000,
    )}s. Is the server still building a PDF?`;
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text)) {
    return `Could not reach the Scribd panel at ${baseUrl} (${text}). Check the server is running on that port and reachable from the internet.`;
  }
  return `Could not reach the Scribd panel at ${baseUrl} (${text}).`;
}

async function panelJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<PanelResult<T>> {
  const { baseUrl, key } = await scribdPanelConfig();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (key) headers['X-Panel-Key'] = key;

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(PANEL_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const message =
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof (parsed as { error?: unknown }).error === 'string'
          ? String((parsed as { error: string }).error)
          : explainPanelStatus(res.status);
      return {
        ok: false,
        status: res.status,
        error: message,
        extra:
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : undefined,
      };
    }
    if (parsed === null || typeof parsed !== 'object') {
      return {
        ok: false,
        status: 502,
        error: `The answer from ${baseUrl}${path} was not JSON. Check SCRIBD_PANEL_URL points at the panel and not at another page.`,
      };
    }
    return { ok: true, data: parsed as T };
  } catch (err) {
    return { ok: false, status: 502, error: explainNetworkError(err, baseUrl) };
  }
}

export function getScribdStatus(): Promise<PanelResult<ScribdPanelStatus>> {
  return panelJson<ScribdPanelStatus>('/status');
}

export function getScribdHealth(): Promise<PanelResult<ScribdPanelHealth>> {
  return panelJson<ScribdPanelHealth>('/health');
}

/**
 * One honest connection test: /health is open (so a locked panel still shows
 * its state), while /status needs the key. A 401 on /status is therefore the
 * only way to prove the saved key is the right one.
 */
export async function testScribdConnection(): Promise<{
  reachable: boolean;
  locked: boolean | null;
  keyAccepted: boolean;
  version: string | null;
  error: string | null;
}> {
  const health = await getScribdHealth();
  if (!health.ok) {
    return {
      reachable: false,
      locked: null,
      keyAccepted: false,
      version: null,
      error: health.error,
    };
  }

  const locked = Boolean(health.data.locked);
  const version = typeof health.data.version === 'string' ? health.data.version : null;
  if (!locked) {
    return { reachable: true, locked, keyAccepted: true, version, error: null };
  }

  const status = await getScribdStatus();
  if (status.ok) {
    return { reachable: true, locked, keyAccepted: true, version, error: null };
  }
  return {
    reachable: true,
    locked,
    keyAccepted: false,
    version,
    error:
      status.status === 401
        ? 'The panel is reachable but refused the key. Copy the panel\'s PANEL_KEY into Panel settings.'
        : status.error,
  };
}

export function findScribdDocuments(
  query: string,
  page = 1,
): Promise<PanelResult<ScribdFindPayload>> {
  return panelJson<ScribdFindPayload>('/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, page }),
  });
}

export function startScribdJob(input: {
  urls?: string[];
  links?: string;
  limit?: number;
  text?: boolean;
  jobs?: number;
}): Promise<
  PanelResult<{ ok: boolean; queued: number; channels?: number; started?: boolean; pending?: number }>
> {
  return panelJson<{ ok: boolean; queued: number; channels?: number; started?: boolean; pending?: number }>('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: input.urls || [],
      links: input.links || '',
      limit: input.limit || 0,
      text: Boolean(input.text),
      jobs: input.jobs || 0,
    }),
  });
}

/**
 * Stop a job the panel thinks is still running.
 *
 * The panel steps over a job that has not moved for seven minutes by itself;
 * this is the "now" button for when you do not want to wait, and the way out
 * of a stuck download that would otherwise block every new one.
 */
export function resetScribdJob(): Promise<PanelResult<{ ok: boolean; stopped: boolean }>> {
  return panelJson<{ ok: boolean; stopped: boolean }>('/reset', { method: 'POST' });
}

export function listScribdFiles(): Promise<PanelResult<{ files: ScribdFile[] }>> {
  return panelJson<{ files: ScribdFile[] }>('/files');
}

/** A file name is a name, never a path: the panel's folder is not a browser. */
export function safeScribdName(raw: string): string {
  const name = (raw || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return '';
  }
  return name.length > 180 ? name.slice(-180) : name;
}

/**
 * One finished PDF, as bytes. Server-side, with the key, so the browser never
 * sees either — it downloads from this dashboard's own origin.
 */
export async function readScribdFile(
  name = '',
): Promise<
  | { ok: true; body: ReadableStream<Uint8Array> | null; filename: string; length: string }
  | { ok: false; status: number; error: string }
> {
  const { baseUrl, key } = await scribdPanelConfig();
  const clean = safeScribdName(name);
  const path = clean ? `/file/${encodeURIComponent(clean)}` : '/file';
  const headers: Record<string, string> = {};
  if (key) headers['X-Panel-Key'] = key;

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const asked = text.trim().slice(0, 160);
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 404
            ? asked || 'The panel has no finished PDF yet.'
            : explainPanelStatus(res.status),
      };
    }
    const fromHeader = /filename="?([^";]+)"?/i.exec(
      res.headers.get('content-disposition') || '',
    );
    // hand the bytes straight on: a phone saving a 150 MB PDF must not wait
    // for the whole thing to be buffered in this function first
    return {
      ok: true,
      body: res.body,
      length: res.headers.get('content-length') || '',
      filename: clean || (fromHeader ? fromHeader[1] : 'scribd-document.pdf'),
    };
  } catch (err) {
    return { ok: false, status: 502, error: explainNetworkError(err, baseUrl) };
  }
}
