'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  Gauge,
  Library,
  ListChecks,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
} from 'lucide-react';
import { authHeaders } from '@/lib/client-session';
import type {
  ScribdFile,
  ScribdFindPayload,
  ScribdHit,
  ScribdStatusPayload,
} from '@/lib/scribd-types';

const POLL_MS = 2_500;

function bytesText(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)} MB`;
  if (count >= 1024) return `${Math.round(count / 1024)} kB`;
  return `${count} B`;
}

function whenText(seconds: number): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function verdictTone(verdict: string): 'ok' | 'warn' | 'bad' | 'idle' {
  if (verdict === 'PDF BUILT') return 'ok';
  if (verdict === 'PDF PARTIAL' || verdict === 'PROBE DONE' ||
      verdict === 'DROPPED') return 'warn';
  if (verdict) return 'bad';
  return 'idle';
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function ScribdDesk() {
  const [status, setStatus] = useState<ScribdStatusPayload | null>(null);
  const [files, setFiles] = useState<ScribdFile[]>([]);
  // set when the panel is on HTTPS itself, so big saves can skip this app
  const [publicBase, setPublicBase] = useState('');
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<ScribdHit[]>([]);
  const [searchPage, setSearchPage] = useState(0);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchName, setSearchName] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);

  const [limit, setLimit] = useState('0');
  const [wantText, setWantText] = useState(false);
  // how many pages are fetched at once — the panel calls these channels
  const [channels, setChannels] = useState('16');
  const [starting, setStarting] = useState(false);
  const [resetting, setResetting] = useState(false);

  // panel address/key live in D1 (portal_settings); this is the admin editor
  const [isAdmin, setIsAdmin] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [panelUrlInput, setPanelUrlInput] = useState('');
  const [panelKeyInput, setPanelKeyInput] = useState('');
  const [hasPanelKey, setHasPanelKey] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const noticeTimer = useRef<number | null>(null);

  const say = useCallback((text: string, bad = false) => {
    setNotice({ text, bad });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), bad ? 9000 : 5000);
  }, []);

  const running = status?.state === 'running';

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scribd/status', {
        headers: authHeaders(),
        cache: 'no-store',
      });
      const json = await readJson(res);
      if (!res.ok) {
        setStatus(null);
        setNotice((current) =>
          current && current.bad
            ? current
            : { text: String(json.error || 'The Scribd panel did not answer.'), bad: true },
        );
        return;
      }
      setStatus(json as unknown as ScribdStatusPayload);
    } catch {
      setStatus(null);
    }
  }, []);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/scribd/files', {
        headers: authHeaders(),
        cache: 'no-store',
      });
      const json = await readJson(res);
      if (!res.ok) return;
      setFiles(Array.isArray(json.files) ? (json.files as ScribdFile[]) : []);
      setPublicBase(typeof json.publicBase === 'string' ? json.publicBase : '');
    } catch {
      // the status poll already reports a panel that is down
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/scribd/config', {
        headers: authHeaders(),
        cache: 'no-store',
      });
      const json = await readJson(res);
      if (!res.ok) return;
      setPanelUrlInput(String(json.panelUrl || ''));
      setHasPanelKey(Boolean(json.hasPanelKey));
      setPanelKeyInput(json.hasPanelKey ? '••••••••' : '');
    } catch {
      // the status card already says the panel is offline
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/me', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = (await res.json()) as { user?: { isAdmin?: boolean } };
        if (json.user?.isAdmin) {
          setIsAdmin(true);
          await loadConfig();
        }
      } catch {
        // not an admin, or signed out: the settings card simply never appears
      }
    })();
  }, [loadConfig]);

  const saveConfig = useCallback(async () => {
    setSavingConfig(true);
    try {
      const payload: Record<string, string> = { panelUrl: panelUrlInput };
      if (panelKeyInput !== '••••••••') payload.panelKey = panelKeyInput;
      const res = await fetch('/api/scribd/config', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const json = await readJson(res);
      if (!res.ok) {
        say(String(json.error || 'Could not save the panel settings.'), true);
        return;
      }
      setHasPanelKey(Boolean(json.hasPanelKey));
      setPanelKeyInput(json.hasPanelKey ? '••••••••' : '');
      const connected = json.reachable === true && json.keyAccepted === true;
      say(
        connected
          ? 'Saved — the panel answered and the key works.'
          : `Saved, but the connection test failed: ${String(json.error || 'unknown reason')}`,
        !connected,
      );
      void loadStatus();
    } catch {
      say('Could not reach this dashboard’s API.', true);
    } finally {
      setSavingConfig(false);
    }
  }, [panelUrlInput, panelKeyInput, say, loadStatus]);

  useEffect(() => {
    void loadStatus();
    void loadFiles();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadStatus();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadStatus, loadFiles]);

  // a finished job is the moment the file list changes
  const lastDone = useRef('');
  useEffect(() => {
    if (status?.state === 'done' && status.verdict !== lastDone.current) {
      lastDone.current = status.verdict;
      void loadFiles();
    }
  }, [status?.state, status?.verdict, loadFiles]);

  const runSearch = useCallback(
    async (page: number) => {
      const words = query.trim();
      if (!words) {
        say('Type a few words to search Scribd for.', true);
        return;
      }
      setSearching(true);
      try {
        const res = await fetch('/api/scribd/find', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ query: words, page }),
        });
        const json = await readJson(res);
        if (!res.ok) {
          say(String(json.error || 'The search did not answer.'), true);
          return;
        }
        const payload = json as unknown as ScribdFindPayload;
        const found = Array.isArray(payload.hits) ? payload.hits : [];
        // Scribd repeats documents across pages, so add only what is new.
        // Work on a plain list here (not inside a state updater): an updater runs
        // later, during render, so reading its result right after is stale.
        const seenIds = new Set(page === 1 ? [] : hits.map((hit) => hit.id));
        const fresh = page === 1 ? found : found.filter((hit) => !seenIds.has(hit.id));
        const merged = page === 1 ? found : [...hits, ...fresh];
        setHits(merged);
        const shown = merged.length;
        const maxPage = payload.max_page || 40;
        const total = payload.total || 0;
        const thisPage = payload.page || page;
        setSearchPage(thisPage);
        setSearchTotal(total);
        setSearchName(payload.summary || `${shown} document(s)`);
        // Keep "Load more" while the search has any results and pages are left.
        // It used to be hidden when Scribd sent no total, which is exactly when
        // a person still wants it; a page that adds nothing simply says so.
        setMore(merged.length > 0 && found.length > 0 && thisPage < maxPage);
        if (!found.length) say('No documents match that.', true);
        else if (page > 1) say(`${found.length} more — ${shown} shown.`);
      } catch {
        say('Could not reach this dashboard’s API.', true);
      } finally {
        setSearching(false);
      }
    },
    [query, hits, say],
  );

  const toggle = useCallback((url: string) => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const start = useCallback(
    async (payload: { urls?: string[] }) => {
      setStarting(true);
      try {
        const res = await fetch('/api/scribd/run', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            ...payload,
            limit: Number(limit) || 0,
            text: wantText,
            jobs: Number(channels) || 16,
          }),
        });
        const json = await readJson(res);
        if (!res.ok) {
          say(String(json.error || 'The download did not start.'), true);
          void loadStatus();
          return;
        }
        // "started: false" is the good case here: a book is already downloading
        // and these were added behind it, not refused.
        const waiting = Number(json.pending) || 0;
        say(
          json.started === false
            ? `Added ${Number(json.queued) || 0} to the queue — ${waiting} waiting. The book already downloading finishes first.`
            : `${Number(json.queued) || 0} document(s) started at ${String(
                json.channels || channels,
              )} channels.`,
        );
        // let the ticked set go, so the next search starts clean
        setTicked(new Set());
        void loadStatus();
      } catch {
        say('Could not reach this dashboard’s API.', true);
      } finally {
        setStarting(false);
      }
    },
    [limit, wantText, channels, say, loadStatus],
  );

  const resetJob = useCallback(async () => {
    setResetting(true);
    try {
      const res = await fetch('/api/scribd/reset', {
        method: 'POST',
        headers: authHeaders(),
      });
      const json = await readJson(res);
      if (!res.ok) {
        say(String(json.error || 'The job could not be stopped.'), true);
        return;
      }
      say(
        json.stopped
          ? 'Stopped the stuck job — you can start a download again.'
          : 'Nothing was running.',
      );
      void loadStatus();
    } catch {
      say('Could not reach this dashboard’s API.', true);
    } finally {
      setResetting(false);
    }
  }, [say, loadStatus]);

  /**
   * Save a finished PDF.
   *
   * A plain navigation, not a blob: the route streams the file and the session
   * cookie authorises it, so a phone can save a 150 MB book without first
   * holding it in memory. The old blob route is what made a save do nothing on
   * a phone on a long download.
   */
  const fileUrl = useCallback(
    (name: string) => {
      const clean = encodeURIComponent(name);
      // straight from the panel when it is published over HTTPS: a 150 MB book
      // then never passes through this app's function (and its time limit)
      return publicBase
        ? `${publicBase}/file/${clean}`
        : `/api/scribd/file?name=${clean}`;
    },
    [publicBase],
  );

  const download = useCallback(
    async (name: string) => {
      let href = fileUrl(name);
      try {
        // ask for a fresh link: when the panel is published, this is a signed
        // direct URL (bytes never touch this app); otherwise it is the proxy
        const res = await fetch(`/api/scribd/link?name=${encodeURIComponent(name)}`, {
          headers: authHeaders(),
          cache: 'no-store',
        });
        const json = await readJson(res);
        if (res.ok && typeof json.url === 'string') href = json.url;
      } catch {
        // fall back to the proxy path
      }
      const link = document.createElement('a');
      link.href = href;
      link.download = name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      say(`${name} — saving. If nothing appears, tap the file name.`);
    },
    [fileUrl, say],
  );

  const progress = status?.progress;
  const queue = status?.queue;
  const percent = useMemo(() => {
    if (!progress || !progress.of) return 0;
    return Math.min(100, Math.round((progress.page / progress.of) * 100));
  }, [progress]);

  const logTail = useMemo(() => (status?.log || []).slice(-14).join('\n'), [status?.log]);
  const tone = verdictTone(status?.verdict || '');

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Library className="h-4 w-4 text-teal-600" />
            <h2 className="text-sm font-bold text-slate-900 sm:text-base">Scribd Library</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
            <span
              className={`rounded-full px-2 py-0.5 ${
                status?.panelOnline
                  ? 'bg-teal-50 text-teal-700'
                  : 'bg-rose-50 text-rose-700'
              }`}
            >
              {status?.panelOnline ? 'panel online' : 'panel offline'}
            </span>
            {status?.health && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                v{status.health.version}
              </span>
            )}
            <span
              className={`rounded-full px-2 py-0.5 ${
                running ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {running ? 'working…' : status?.state || 'idle'}
            </span>
            <button
              type="button"
              onClick={() => {
                void loadStatus();
                void loadFiles();
              }}
              title="Refresh"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Books come from Scribd into the server beside this dashboard, and land here as PDFs.
          Search, tick what you want (or mark all), and download.
        </p>
      </section>

      {isAdmin && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <button
            type="button"
            onClick={() => setConfigOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Settings2 className="h-4 w-4 text-teal-600" /> Panel settings
            </span>
            <span className="text-[11px] font-semibold text-slate-500">
              {hasPanelKey ? 'key saved' : 'open panel'} · {configOpen ? 'hide' : 'show'}
            </span>
          </button>

          {configOpen && (
            <div className="mt-3 space-y-2">
              <label className="block text-[11px] font-semibold text-slate-600">
                Panel address
                <input
                  value={panelUrlInput}
                  onChange={(event) => setPanelUrlInput(event.target.value)}
                  placeholder="http://195.123.189.187:25811"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
                />
              </label>
              <label className="block text-[11px] font-semibold text-slate-600">
                Panel key <span className="font-normal text-slate-400">(blank = panel is open)</span>
                <input
                  value={panelKeyInput}
                  onChange={(event) => setPanelKeyInput(event.target.value)}
                  placeholder="the panel's PANEL_KEY"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveConfig()}
                  disabled={savingConfig}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {savingConfig ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Save &amp; test
                </button>
                <span className="text-[11px] text-slate-500">
                  Saved in D1 (portal_settings), so no redeploy is needed.
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {notice && (
        <div
          role="status"
          className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
            notice.bad
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : 'border-teal-200 bg-teal-50 text-teal-900'
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            {notice.bad ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600" />
            )}
            <span className="min-w-0 break-words">{notice.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 text-[11px] font-semibold underline"
          >
            Close
          </button>
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Search className="h-4 w-4 text-teal-600" /> Find a book
        </h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch(1);
            }}
            placeholder="physics 12th"
            /* 16px on a phone stops iOS zooming the page when the box is tapped,
               which is what used to push the Find button out of reach */
            className="min-w-0 flex-1 touch-manipulation rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-100 sm:text-sm"
          />
          <button
            type="button"
            onClick={() => void runSearch(1)}
            disabled={searching}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50 sm:min-h-0 sm:w-auto sm:text-xs"
          >
            {searching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Find
          </button>
          {searchName && (
            <span className="text-[11px] font-semibold text-slate-500">
              {searchName}
              {searchTotal > 0 ? ` · ${searchTotal} match(es)` : ''}
            </span>
          )}
        </div>

        {hits.length > 0 && (
          <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-100">
            {hits.map((hit) => (
              <label
                key={hit.id}
                className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={ticked.has(hit.url)}
                  onChange={() => toggle(hit.url)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-teal-600"
                />
                <span className="min-w-0">
                  <span
                    className={`block line-clamp-2 text-xs font-semibold ${
                      hit.match === 'none' ? 'text-slate-600' : 'text-slate-900'
                    }`}
                  >
                    {hit.title}
                    {hit.match === 'none' && (
                      <span className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                        related
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">
                    {[hit.pages ? `${hit.pages} pages` : '', hit.views ? `${hit.views} views` : '', hit.author]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {hits.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setTicked(new Set(hits.map((hit) => hit.url)))}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              <ListChecks className="h-3.5 w-3.5" /> Mark all ({hits.length})
            </button>
            <button
              type="button"
              onClick={() => setTicked(new Set())}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              Clear
            </button>
            <span className="text-[11px] font-semibold text-slate-500">
              {ticked.size ? `${ticked.size} ticked` : 'nothing ticked yet'}
            </span>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={() => void start({ urls: [...ticked] })}
            disabled={starting || ticked.size === 0}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40 sm:min-h-0 sm:w-auto sm:text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            {running ? `Add to queue (${ticked.size})` : `Download ticked (${ticked.size})`}
          </button>
          {more && (
            <button
              type="button"
              onClick={() => void runSearch(searchPage + 1)}
              disabled={searching}
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:opacity-50"
            >
              Load more
            </button>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Gauge className="h-4 w-4 text-teal-600" /> How it downloads
        </h3>
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-[11px] font-semibold text-slate-600">Channels</p>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5 rounded-xl bg-slate-100 p-1">
              {['8', '12', '16', '24'].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChannels(value)}
                  className={`min-h-9 rounded-lg px-2 py-1.5 text-xs font-bold tabular-nums transition ${
                    channels === value
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">
              Pages fetched at once. More is not always faster: Scribd throttles by
              address, so 24 can be slower than 16 — the log shows the rate it
              actually reached.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              pages
              <input
                type="number"
                min={0}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                className="w-16 rounded-lg border border-slate-200 px-2 py-1.5 text-base text-slate-900 outline-none focus:border-teal-300 sm:text-xs"
              />
              <span className="font-normal text-slate-400">0 = whole document</span>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={wantText}
                onChange={(event) => setWantText(event.target.checked)}
                className="h-4 w-4 accent-teal-600"
              />
              searchable text
            </label>
          </div>
          <p className="text-[11px] text-slate-500">
            Searchable text adds each page&rsquo;s real words, one extra request per
            page, so the PDF can be searched and copied.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <BookOpen className="h-4 w-4 text-teal-600" /> Progress
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
              tone === 'ok'
                ? 'bg-teal-50 text-teal-700'
                : tone === 'warn'
                  ? 'bg-amber-50 text-amber-700'
                  : tone === 'bad'
                    ? 'bg-rose-50 text-rose-700'
                    : 'bg-slate-100 text-slate-600'
            }`}
          >
            {status?.verdict || (running ? 'working…' : 'idle')}
          </span>
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-teal-500 transition-all"
            style={{ width: `${running || tone !== 'idle' ? percent : 0}%` }}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-500 tabular-nums">
          <span>
            {queue && queue.total > 1
              ? `book ${Math.min(queue.done + 1, queue.total)} of ${queue.total} · `
              : ''}
            page {progress?.page || 0}/{progress?.of || 0} · {progress?.ok || 0} ok
            {progress?.skipped ? ` · ${progress.skipped} retrying` : ''}
          </span>
          <span>{status?.seconds ? `${status.seconds}s` : ''}</span>
        </div>

        {queue && queue.total > 1 && (
          <p className="mt-1.5 text-[11px] font-semibold text-slate-600">
            {queue.pending + (queue.current ? 1 : 0)} waiting · {queue.done} finished
            {queue.current ? ` · now: ${queue.current.split('/').pop()}` : ''}
          </p>
        )}

        {queue && queue.results.length > 0 && (
          <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-100">
            {queue.results.map((row) => (
              <li
                key={`${row.url}-${row.file}`}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5"
              >
                <span className="min-w-0 truncate text-[11px] text-slate-700">
                  {row.title || row.url}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    row.verdict === 'PDF BUILT'
                      ? 'bg-teal-50 text-teal-700'
                      : row.verdict === 'PDF PARTIAL' ||
                          row.verdict === 'DROPPED'
                        ? 'bg-amber-50 text-amber-700'
                        : 'bg-rose-50 text-rose-700'
                  }`}
                >
                  {row.verdict.replace('PDF ', '')}
                </span>
              </li>
            ))}
          </ul>
        )}

        {status?.stalled && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
            <p className="min-w-0 flex-1 text-[11px] font-medium text-amber-900">
              Nothing has moved for {Math.round(Number(status.quiet) || 0)}s. A new
              download steps over it after{' '}
              {Math.round((Number(status.stall_after) || 420) / 60)} min, or stop it now.
            </p>
            {isAdmin ? (
              <button
                type="button"
                onClick={() => void resetJob()}
                disabled={resetting}
                className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                {resetting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                Stop it
              </button>
            ) : (
              <span className="text-[11px] font-semibold text-amber-800">
                The administrator can stop it.
              </span>
            )}
          </div>
        )}

        {status?.detail && (
          <p className="mt-2 break-words rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {status.detail}
          </p>
        )}

        <pre className="mt-3 max-h-56 overflow-auto rounded-xl bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
{logTail || '(no output yet)'}
        </pre>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <FileText className="h-4 w-4 text-teal-600" /> Finished PDFs
          <span className="font-mono text-[11px] font-normal text-slate-500 tabular-nums">
            {files.length}
          </span>
        </h3>
        {files.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">Nothing built yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {files.map((file) => (
              <li key={file.name} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <a
                    href={fileUrl(file.name)}
                    download={file.name}
                    className="block truncate text-xs font-semibold text-slate-900 underline-offset-2 hover:text-teal-700 hover:underline"
                  >
                    {file.name}
                  </a>
                  <p className="text-[11px] text-slate-500 tabular-nums">
                    {bytesText(file.bytes)} · {whenText(file.when)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => download(file.name)}
                  className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  Save
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-slate-400">
          Tap a file name to save it. The PDF is streamed through this dashboard, so a
          phone never has to hold the whole book in memory.
        </p>
      </section>
    </div>
  );
}
