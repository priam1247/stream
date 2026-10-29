/** Shapes used by the dashboard's Scribd web-service adapter. */

export interface ScribdHit {
  id: string;
  title: string;
  url: string;
  pages: number;
  views: string;
  author: string;
  /** A Scribd-hosted cover, when the search service provides one. */
  thumbnail?: string;
  score?: number;
  match?: 'all' | 'some' | 'none';
}

export interface ScribdFindPayload {
  hits: ScribdHit[];
  notes: string[];
  summary: string;
  page: number;
  total: number;
  documents: number;
  /** The web service has no total-page count; the next page can be probed. */
  max_page: number;
  per_page: number;
}

export type ScribdJobItemState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';

/** One item as reported by the existing /api/job endpoint. */
export interface ScribdJobItem {
  id: string;
  title: string;
  status: ScribdJobItemState;
  done: number;
  total: number;
  detail: string;
  error: string;
  pdf: string;
  size: number;
  started: number;
  offloaded: boolean;
  recovered: boolean;
  drime: { id: string; name: string; url: string } | null;
}

export interface ScribdPanelStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  active: number;
  finished: number;
  failed: number;
  cancelled: boolean;
  items: ScribdJobItem[];
}

export interface ScribdPanelHealth {
  ok: boolean;
}

export interface ScribdStatusPayload extends ScribdPanelStatus {
  panelOnline: boolean;
}

/** A local PDF or an item the server says it has moved to Drime. */
export interface ScribdFile {
  id: string;
  name: string;
  title: string;
  bytes: number;
  when: number;
  source: 'server' | 'drime';
  shareUrl?: string;
}
