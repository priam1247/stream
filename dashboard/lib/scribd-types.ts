/**
 * Shapes shared by the Scribd panel client and the panel UI.
 *
 * They mirror exactly what `GET /status`, `POST /find`, `GET /files` answer in
 * `tools/scribd_download.py`, so nothing is guessed on this side.
 */

export interface ScribdProgress {
  page: number;
  of: number;
  ok: number;
  skipped: number;
  blank: number;
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
