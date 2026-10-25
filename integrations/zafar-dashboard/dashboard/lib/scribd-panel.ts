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
 * Environment:
 *   SCRIBD_PANEL_URL   e.g. http://195.123.189.187:25811   (default below)
 *   SCRIBD_PANEL_KEY   the panel's PANEL_KEY, if it was locked
 */

import type {
  ScribdFile,
  ScribdFindPayload,
  ScribdPanelHealth,
  ScribdPanelStatus,
} from './scribd-types';

const DEFAULT_PANEL_URL = 'http://195.123.189.187:25811';
const PANEL_TIMEOUT_MS = 20_000;
const FILE_TIMEOUT_MS = 120_000;

export type PanelResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export interface ScribdPanelConfig {
  baseUrl: string;
  key: string;
}

/** The panel address, cleaned so a pasted link still works. */
export function scribdPanelConfig(): ScribdPanelConfig {
  const raw = (process.env.SCRIBD_PANEL_URL || DEFAULT_PANEL_URL).trim();
  let baseUrl = DEFAULT_PANEL_URL;
  try {
    const parsed = new URL(raw);
    // A pasted panel link often includes ?key=… or a trailing slash.
    parsed.search = '';
    parsed.hash = '';
    baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    baseUrl = DEFAULT_PANEL_URL;
  }
  return { baseUrl, key: (process.env.SCRIBD_PANEL_KEY || '').trim() };
}

function explainPanelStatus(status: number): string {
  if (status === 401) {
    return 'The Scribd panel is locked and SCRIBD_PANEL_KEY is missing or wrong. Set it to the panel\'s PANEL_KEY.';
  }
  if (status === 404) {
    return 'The Scribd panel did not recognise that route. Update tools/scribd_download.py to v2.12 or newer.';
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
  const { baseUrl, key } = scribdPanelConfig();
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
      return { ok: false, status: res.status, error: message };
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
}): Promise<PanelResult<{ ok: boolean; queued: number }>> {
  return panelJson<{ ok: boolean; queued: number }>('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: input.urls || [],
      links: input.links || '',
      limit: input.limit || 0,
      text: Boolean(input.text),
    }),
  });
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
  | { ok: true; data: ArrayBuffer; filename: string }
  | { ok: false; status: number; error: string }
> {
  const { baseUrl, key } = scribdPanelConfig();
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
    const data = await res.arrayBuffer();
    const fromHeader = /filename="?([^";]+)"?/i.exec(
      res.headers.get('content-disposition') || '',
    );
    return {
      ok: true,
      data,
      filename: clean || (fromHeader ? fromHeader[1] : 'scribd-document.pdf'),
    };
  } catch (err) {
    return { ok: false, status: 502, error: explainNetworkError(err, baseUrl) };
  }
}
