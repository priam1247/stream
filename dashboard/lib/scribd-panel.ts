/**
 * Server-only adapter for the existing `scribd/scribd_web.py` service.
 * The browser calls dashboard routes; the web-service token stays server-side.
 */
import { normalizeScribdHit, safeScribdThumbnail, scribdDocumentId } from './scribd-search';
import { filesFromJob, safeScribdName } from './scribd-job';
import { DEFAULT_SCRIBD_WEB_URL, TEMPORARY_INSECURE_SCRIBD_ORIGIN } from './scribd-config';
export { filesFromJob, safeScribdName } from './scribd-job';
export { DEFAULT_SCRIBD_WEB_URL } from './scribd-config';
import type {
  ScribdFile,
  ScribdFindPayload,
  ScribdHit,
  ScribdJobItem,
  ScribdJobItemState,
  ScribdPanelHealth,
  ScribdPanelStatus,
} from './scribd-types';

const REQUEST_TIMEOUT_MS = 20_000;
// Search starts Chromium and can wait for Scribd's challenge/reader to load.
const SEARCH_TIMEOUT_MS = 240_000;
const FILE_TIMEOUT_MS = 300_000;
const MAX_DOCUMENTS = 200;
const MAX_SEARCH_PAGE = 40;

export type PanelResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export interface ScribdPanelConfig {
  baseUrl: string;
  key: string;
}

/** Strip pasted query strings and credentials; never send a token to an invalid URL. */
export function cleanPanelUrl(raw: string): string {
  try {
    const parsed = new URL(raw.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Use the current server by default. Legacy panel settings may refer to a
 * different service, so neither their address nor their key is used here.
 * Environment overrides remain available if the server moves or is secured.
 */
export async function scribdPanelConfig(): Promise<ScribdPanelConfig> {
  const webUrl = (process.env.SCRIBD_WEB_URL || '').trim() || DEFAULT_SCRIBD_WEB_URL;
  return {
    baseUrl: cleanPanelUrl(webUrl),
    key: (process.env.SCRIBD_WEB_TOKEN || '').trim(),
  };
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  authenticated?: boolean;
  accept?: string;
};

/** The web server authenticates with `?t=`, not the old X-Panel-Key header. */
async function panelRequest(path: string, options: RequestOptions = {}): Promise<PanelResult<Response>> {
  let config: ScribdPanelConfig;
  try {
    config = await scribdPanelConfig();
  } catch {
    return { ok: false, status: 503, error: 'Could not load the Scribd server configuration.' };
  }
  if (!config.baseUrl) {
    return { ok: false, status: 503, error: 'The Scribd server address is invalid. Check SCRIBD_WEB_URL.' };
  }

  const url = new URL(`${config.baseUrl}${path}`);
  // The selected server uses public HTTP, which exposes its token and traffic.
  // Keep this exception restricted to that origin; never forward the token to
  // a different HTTP host due to a stale configuration override.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const selectedServer = url.origin === TEMPORARY_INSECURE_SCRIBD_ORIGIN;
  if (options.authenticated !== false && config.key && url.protocol !== 'https:' && !loopback && !selectedServer) {
    return { ok: false, status: 503, error: 'Scribd needs HTTPS for this server. Check SCRIBD_WEB_URL.' };
  }
  for (const [name, value] of Object.entries(options.query || {})) url.searchParams.set(name, value);
  if (options.authenticated !== false && config.key) url.searchParams.set('t', config.key);
  const headers: Record<string, string> = { Accept: options.accept || 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      // Never follow a redirect carrying the server's bearer token to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeout || REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = '';
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') message = parsed.error;
      } catch {
        // The web server's authentication and file errors are plain text.
      }
      if (config.key) {
        const encoded = new URLSearchParams({ t: config.key }).toString().slice(2);
        const secrets = new Set([config.key, encoded, encoded.replace(/\+/g, '%20')]);
        for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
          message = message.split(secret).join('[redacted]');
        }
      }
      if (response.status === 401 || response.status === 403) {
        message = 'The Scribd server rejected its token. Ask the administrator to check SCRIBD_WEB_TOKEN.';
      } else if (response.status === 404 && !message) {
        message = 'The Scribd server could not find the requested endpoint or file.';
      }
      return {
        ok: false,
        status: response.status,
        error: message.trim().slice(0, 600) || `The Scribd server returned HTTP ${response.status}.`,
      };
    }
    return { ok: true, data: response };
  } catch (error) {
    const timedOut = error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`);
    return {
      ok: false,
      status: 502,
      error: timedOut
        ? 'The Scribd server took too long to respond. Try again or check its browser and queue.'
        : 'Could not reach the Scribd server. Check its address, network access, and that it is running.',
    };
  }
}

async function panelJson(path: string, options: RequestOptions = {}): Promise<PanelResult<Record<string, unknown>>> {
  const result = await panelRequest(path, options);
  if (!result.ok) return result;
  try {
    const data: unknown = await result.data.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return { ok: false, status: 502, error: 'The Scribd server returned an unexpected response.' };
  }
}

function nonnegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function safeText(value: unknown, max = 600): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Only expose legitimate HTTPS Drime share links to the browser. */
export function safeDrimeShareUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = ['dri.me', 'drime.cloud'].some((domain) => host === domain || host.endsWith(`.${domain}`));
    return url.protocol === 'https:' && allowed && !url.username && !url.password && !url.port ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeJobItem(value: unknown): ScribdJobItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? '').trim().slice(0, 240);
  if (!id) return null;
  const validStates: ScribdJobItemState[] = ['queued', 'running', 'done', 'failed', 'cancelled'];
  const state = String(item.status ?? '') as ScribdJobItemState;
  const drime = item.drime && typeof item.drime === 'object' && !Array.isArray(item.drime)
    ? item.drime as Record<string, unknown>
    : null;
  return {
    id,
    title: safeText(item.title, 200) || `Document ${id}`,
    status: validStates.includes(state) ? state : 'unknown',
    done: nonnegative(item.done),
    total: nonnegative(item.total),
    detail: safeText(item.detail),
    error: safeText(item.error),
    pdf: safeScribdName(typeof item.pdf === 'string' ? item.pdf : ''),
    size: nonnegative(item.size),
    started: nonnegative(item.started),
    offloaded: item.offloaded === true,
    recovered: item.recovered === true,
    drime: drime ? {
      id: safeText(String(drime.id ?? ''), 120),
      name: safeText(drime.name, 240),
      url: safeDrimeShareUrl(drime.url),
    } : null,
  };
}

function normalizeJob(data: Record<string, unknown>): PanelResult<ScribdPanelStatus> {
  if (!Array.isArray(data.items)) {
    return { ok: false, status: 502, error: 'The Scribd server returned an invalid job list.' };
  }
  const items = data.items.map(normalizeJobItem).filter((item): item is ScribdJobItem => item !== null);
  const active = items.filter((item) => item.status === 'queued' || item.status === 'running').length;
  const finished = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const cancelled = data.cancelled === true;
  return {
    ok: true,
    data: {
      state: active ? 'running' : cancelled ? 'cancelled' : failed ? 'failed' : finished ? 'done' : 'idle',
      active,
      finished,
      failed,
      cancelled,
      items,
    },
  };
}

export async function getScribdHealth(): Promise<PanelResult<ScribdPanelHealth>> {
  const result = await panelRequest('/health', { authenticated: false, accept: 'text/plain' });
  if (!result.ok) return result;
  const text = await result.data.text().catch(() => '');
  return text.trim() === 'ok'
    ? { ok: true, data: { ok: true } }
    : { ok: false, status: 502, error: 'The address did not return the expected Scribd health response.' };
}

export async function getScribdStatus(): Promise<PanelResult<ScribdPanelStatus>> {
  const result = await panelJson('/api/job');
  return result.ok ? normalizeJob(result.data) : result;
}

/** /health is public; the protected job endpoint is needed to verify a token. */
export async function testScribdConnection(): Promise<{
  reachable: boolean;
  locked: boolean | null;
  keyAccepted: boolean;
  version: string | null;
  error: string | null;
}> {
  const health = await getScribdHealth();
  if (!health.ok) return { reachable: false, locked: null, keyAccepted: false, version: null, error: health.error };
  const job = await getScribdStatus();
  if (!job.ok) {
    return { reachable: true, locked: job.status === 401 || job.status === 403 ? true : null, keyAccepted: false, version: null, error: job.error };
  }
  // A successful request cannot prove whether the server is actually locked.
  return { reachable: true, locked: null, keyAccepted: true, version: null, error: null };
}

/** Search has real page requests but does not return a total page count. */
export async function findScribdDocuments(query: string, page = 1): Promise<PanelResult<ScribdFindPayload>> {
  const requestedPage = Math.max(1, Math.min(Math.floor(Number(page) || 1), MAX_SEARCH_PAGE));
  const result = await panelJson('/api/search', {
    query: { q: query.trim(), page: String(requestedPage) },
    timeout: SEARCH_TIMEOUT_MS,
  });
  if (!result.ok) return result;
  if (!Array.isArray(result.data.items)) {
    return { ok: false, status: 502, error: 'The Scribd server returned an invalid search result.' };
  }
  const hits: ScribdHit[] = result.data.items
    .map(normalizeScribdHit)
    .filter((hit): hit is ScribdHit => Boolean(hit && /^\d{1,20}$/.test(hit.id) && scribdDocumentId(hit.url) === hit.id));
  return {
    ok: true,
    data: {
      hits,
      notes: [],
      summary: typeof result.data.title === 'string' ? result.data.title : '',
      page: requestedPage,
      total: hits.length,
      documents: hits.length,
      // Match the service's own UI: try the next page until it is empty or repeats.
      max_page: hits.length && requestedPage < MAX_SEARCH_PAGE ? requestedPage + 1 : requestedPage,
      per_page: hits.length,
    },
  };
}

type DocumentInput = { id?: unknown; title?: unknown; pages?: unknown; url?: unknown };
type DownloadDocument = { id: string; title: string; pages: number | null };

function documentFrom(value: unknown): DownloadDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const doc = value as DocumentInput;
  const id = String(doc.id ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) return null;
  if (doc.url !== undefined && scribdDocumentId(doc.url) !== id) return null;
  const pages = nonnegative(doc.pages);
  return { id, title: safeText(doc.title, 200) || `Document ${id}`, pages: pages || null };
}

export async function startScribdJob(input: {
  docs?: unknown[];
  urls?: string[];
  links?: string;
}): Promise<PanelResult<{ ok: true; queued: number; skipped: number; acceptedIds: string[]; message: string }>> {
  const docs: DownloadDocument[] = [];
  for (const raw of input.docs || []) {
    const doc = documentFrom(raw);
    if (!doc) return { ok: false, status: 400, error: 'A selected document has an invalid Scribd ID or link.' };
    docs.push(doc);
  }
  const links = [...(input.urls || []), ...String(input.links || '').split(/[\s,]+/).filter(Boolean)];
  for (const link of links) {
    const id = scribdDocumentId(link);
    if (!id) return { ok: false, status: 400, error: 'Only Scribd document links can be submitted.' };
    docs.push({ id, title: `Document ${id}`, pages: null });
  }
  const wanted = [...new Map(docs.map((doc) => [doc.id, doc])).values()];
  if (!wanted.length) return { ok: false, status: 400, error: 'Select at least one document.' };
  if (wanted.length > MAX_DOCUMENTS) {
    return { ok: false, status: 400, error: `Select at most ${MAX_DOCUMENTS} documents at a time.` };
  }

  // The web service silently ignores IDs already in any queue state, including
  // failed or finished items. Inspect the queue so the UI does not claim they
  // were started or discard those selections.
  const previous = await getScribdStatus();
  if (!previous.ok) return previous;
  const existing = new Set(previous.data.items.map((item) => item.id));
  const fresh = wanted.filter((doc) => !existing.has(doc.id));
  const skipped = wanted.length - fresh.length;
  if (!fresh.length) {
    return { ok: true, data: { ok: true, queued: 0, skipped, acceptedIds: [], message: 'Already in the queue or history. Clear the queue before submitting again.' } };
  }

  // Omitted options intentionally use the server's own defaults.
  const result = await panelJson('/api/download', { method: 'POST', body: { docs: fresh } });
  if (!result.ok) return result;
  const job = normalizeJob(result.data);
  if (!job.ok) return job;
  const returned = new Set(job.data.items.map((item) => item.id));
  const acceptedIds = fresh.filter((doc) => returned.has(doc.id)).map((doc) => doc.id);
  if (acceptedIds.length !== fresh.length) {
    return { ok: false, status: 502, error: 'The Scribd server did not confirm every document. Check the queue before retrying.' };
  }
  const message = skipped
    ? `${acceptedIds.length} added. ${skipped} already in the queue or history; clear it before retrying.`
    : `${acceptedIds.length} document${acceptedIds.length === 1 ? '' : 's'} added to the queue.`;
  return { ok: true, data: { ok: true, queued: acceptedIds.length, skipped, acceptedIds, message } };
}

export async function resetScribdJob(): Promise<PanelResult<{ requested: boolean }>> {
  const result = await panelJson('/api/cancel', { method: 'POST', body: {} });
  if (!result.ok) return result;
  const state = normalizeJob(result.data);
  return state.ok ? { ok: true, data: { requested: state.data.cancelled } } : state;
}

export async function clearScribdQueue(): Promise<PanelResult<ScribdPanelStatus>> {
  const result = await panelJson('/api/clear', { method: 'POST', body: {} });
  return result.ok ? normalizeJob(result.data) : result;
}

export async function listScribdFiles(): Promise<PanelResult<{ files: ScribdFile[] }>> {
  const job = await getScribdStatus();
  return job.ok ? { ok: true, data: { files: filesFromJob(job.data.items) } } : job;
}

export async function readScribdFile(name: string): Promise<
  PanelResult<{ body: ReadableStream<Uint8Array> | null; filename: string; length: string }>
> {
  const clean = safeScribdName(name);
  if (!clean) return { ok: false, status: 400, error: 'That PDF name is not valid.' };
  const result = await panelRequest(`/files/${encodeURIComponent(clean)}`, {
    timeout: FILE_TIMEOUT_MS,
    accept: 'application/pdf',
  });
  if (!result.ok) {
    return result.status === 404
      ? { ok: false, status: 404, error: 'This PDF is not on the server. It may have been moved to Drime.' }
      : result;
  }
  return {
    ok: true,
    data: { body: result.data.body, filename: clean, length: result.data.headers.get('content-length') || '' },
  };
}

export async function readScribdThumbnail(value: unknown): Promise<
  PanelResult<{ body: ReadableStream<Uint8Array> | null; type: string; length: string }>
> {
  const thumbnail = safeScribdThumbnail(value);
  if (!thumbnail) return { ok: false, status: 400, error: 'Invalid Scribd cover URL.' };
  const result = await panelRequest('/api/thumb', { query: { u: thumbnail }, timeout: 35_000, accept: 'image/*' });
  if (!result.ok) return result;
  const type = (result.data.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const length = result.data.headers.get('content-length') || '';
  if (!/^image\/(?:jpeg|png|webp|gif|avif)$/.test(type) || Number(length) > 8 * 1024 * 1024) {
    return { ok: false, status: 502, error: 'The Scribd server returned an invalid cover.' };
  }
  return { ok: true, data: { body: result.data.body, type, length } };
}
