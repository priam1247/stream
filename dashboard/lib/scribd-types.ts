/**
 * Shapes shared by the Scribd panel client and the panel UI.
 *
 * They mirror exactly what `GET /status`, `POST /find`, `GET /files` answer in
 * `tools/downloader/scribd_download.py`, so nothing is guessed on this side.
 */

export interface ScribdProgress {
  page: number;
  of: number;
  ok: number;
  skipped: number;
  blank: number;
}

/** One document that finished inside the queue. */
export interface ScribdQueueResult {
  url: string;
  title: string;
  file: string;
  verdict: string;
  detail: string;
}

/** The documents waiting behind the one in flight. */
export interface ScribdQueue {
  pending: number;
  done: number;
  total: number;
  current: string;
  results: ScribdQueueResult[];
}

export interface ScribdPanelStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | string;
  verdict: string;
  detail: string;
  url: string;
  title: string;
  file: string;
  seconds: number;
  version: string;
  cookies: string;
  sample: string;
  progress: ScribdProgress;
  log: string[];
  /** seconds since the last page arrived (0 when nothing is running) */
  quiet?: number;
  /** running, but nothing has moved for `stall_after` seconds */
  stalled?: boolean;
  stall_after?: number;
  /** documents waiting, the one in flight, and the finished ones */
  queue?: ScribdQueue;
}

export interface ScribdPanelHealth {
  ok: boolean;
  version: string;
  locked: boolean;
  state: string;
}

export interface ScribdHit {
  id: string;
  title: string;
  url: string;
  pages: number;
  views: string;
  author: string;
  /** A Scribd-hosted cover, when the search service provides one. */
  thumbnail?: string;
  /** how well the title matches the words that were typed */
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
  max_page: number;
  per_page: number;
}

export interface ScribdFile {
  name: string;
  bytes: number;
  when: number;
}

/** What `/api/scribd/status` answers: the job plus whether the panel is up. */
export interface ScribdStatusPayload extends ScribdPanelStatus {
  panelOnline: boolean;
  health: ScribdPanelHealth | null;
}
