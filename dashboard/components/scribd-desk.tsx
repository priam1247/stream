'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  Library,
  Link2,
  Loader2,
  RefreshCw,
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
  if (verdict === 'PDF PARTIAL' || verdict === 'PROBE DONE') return 'warn';
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
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<ScribdHit[]>([]);
  const [searchPage, setSearchPage] = useState(0);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchName, setSearchName] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);

  const [links, setLinks] = useState('');
  const [limit, setLimit] = useState('0');
  const [wantText, setWantText] = useState(false);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState('');

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
        setHits((current) => (page === 1 ? found : [...current, ...found]));
        setSearchPage(payload.page || page);
        setSearchTotal(payload.total || 0);
        setSearchName(payload.summary || `${found.length} document(s)`);
        setMore(found.length > 0);
        if (!found.length) say('No documents match that.', true);
      } catch {
        say('Could not reach this dashboard’s API.', true);
      } finally {
        setSearching(false);
      }
    },
    [query, say],
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
    async (payload: { urls?: string[]; links?: string }) => {
      setStarting(true);
      try {
        const res = await fetch('/api/scribd/run', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            ...payload,
            limit: Number(limit) || 0,
            text: wantText,
          }),
        });
        const json = await readJson(res);
        if (!res.ok) {
          say(String(json.error || 'The download did not start.'), true);
          return;
        }
        say(`Queued ${String(json.queued || '')} document(s) — progress below.`);
        void loadStatus();
      } catch {
        say('Could not reach this dashboard’s API.', true);
      } finally {
        setStarting(false);
      }
    },
    [limit, wantText, say, loadStatus],
  );

  const download = useCallback(
    async (name: string) => {
      setDownloading(name);
      try {
        const res = await fetch(`/api/scribd/file?name=${encodeURIComponent(name)}`, {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (!res.ok) {
          const json = await readJson(res);
          say(String(json.error || 'That file could not be fetched.'), true);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      } catch {
        say('The download stopped before it finished.', true);
      } finally {
        setDownloading('');
      }
    },
    [say],
  );

  const progress = status?.progress;
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
          Search below, tick what you want, or paste links.
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
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
          />
          <button
            type="button"
            onClick={() => void runSearch(1)}
            disabled={searching}
            className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
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
                className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={ticked.has(hit.url)}
                  onChange={() => toggle(hit.url)}
                  className="mt-1 h-3.5 w-3.5 accent-teal-600"
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-slate-900">
                    {hit.title}
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

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void start({ urls: [...ticked] })}
            disabled={starting || running || ticked.size === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" /> Download ticked ({ticked.size})
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
          <Link2 className="h-4 w-4 text-teal-600" /> Or paste links
        </h3>
        <textarea
          value={links}
          onChange={(event) => setLinks(event.target.value)}
          placeholder="https://www.scribd.com/document/750213011/Physics-12th"
          rows={3}
          className="mt-3 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-100"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
            pages
            <input
              type="number"
              min={0}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900 outline-none focus:border-teal-300"
            />
            <span className="font-normal text-slate-400">0 = whole document</span>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
            <input
              type="checkbox"
              checked={wantText}
              onChange={(event) => setWantText(event.target.checked)}
              className="h-3.5 w-3.5 accent-teal-600"
            />
            searchable text
          </label>
          <button
            type="button"
            onClick={() => void start({ links })}
            disabled={starting || running || !links.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </button>
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
            page {progress?.page || 0}/{progress?.of || 0} · {progress?.ok || 0} ok
            {progress?.skipped ? ` · ${progress.skipped} retrying` : ''}
          </span>
          <span>{status?.seconds ? `${status.seconds}s` : ''}</span>
        </div>

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
                  <p className="truncate text-xs font-semibold text-slate-900">{file.name}</p>
                  <p className="text-[11px] text-slate-500 tabular-nums">
                    {bytesText(file.bytes)} · {whenText(file.when)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void download(file.name)}
                  disabled={downloading === file.name}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:opacity-50"
                >
                  {downloading === file.name ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Save
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-slate-400">
          Very large books are better downloaded straight from the panel address.
        </p>
      </section>
    </div>
  );
}
