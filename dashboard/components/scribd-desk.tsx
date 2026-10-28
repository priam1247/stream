'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Library,
  ListChecks,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react';
import { authHeaders } from '@/lib/client-session';
import { safeScribdThumbnail } from '@/lib/scribd-search';
import type {
  ScribdFile,
  ScribdFindPayload,
  ScribdHit,
  ScribdStatusPayload,
} from '@/lib/scribd-types';

const POLL_MS = 2_500;
const RESULTS_PER_BATCH = 12;

function ResultCover({ thumbnail }: { thumbnail?: string }) {
  const [failedSrc, setFailedSrc] = useState('');
  const src = safeScribdThumbnail(thumbnail);

  return (
    <span aria-hidden="true" className="relative block aspect-[3/4] overflow-hidden bg-slate-100">
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-teal-50 via-slate-100 to-slate-200 px-2 text-center text-slate-400">
        <BookOpen className="h-6 w-6 text-teal-600/50 sm:h-7 sm:w-7" />
        <span className="text-[9px] font-semibold leading-tight">Cover unavailable</span>
      </span>
      {src && src !== failedSrc && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
        />
      )}
    </span>
  );
}

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
  const [searchQuery, setSearchQuery] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(true);
  const [visibleCount, setVisibleCount] = useState(RESULTS_PER_BATCH);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);

  const [starting, setStarting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

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

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (!res.ok) return;
        const json = (await res.json()) as { user?: { isAdmin?: boolean } };
        if (active) setIsAdmin(Boolean(json.user?.isAdmin));
      } catch {
        // The stop control remains unavailable without an admin session.
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

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
    async (page: number, previousQuery?: string) => {
      const words = (previousQuery ?? query).trim();
      if (!words) {
        say('Type a few words to search Scribd for.', true);
        return;
      }
      if (searching) return;
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
        const previous = page === 1 ? [] : hits;
        // A document can appear more than once, including within a single page.
        const seen = new Set(previous.map((hit) => hit.id || hit.url));
        const fresh = found.filter((hit) => {
          const key = hit && (hit.id || hit.url);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const merged = [...previous, ...fresh];
        const thisPage = Math.max(1, Number(payload.page) || page);
        const maxPage = Math.min(40, Math.max(thisPage, Number(payload.max_page) || thisPage));

        setHits(merged);
        setHasSearched(true);
        setSearchQuery(words);
        setSearchPage(thisPage);
        setSearchTotal(Math.max(merged.length, Number(payload.total) || 0));
        setSearchName(typeof payload.summary === 'string' ? payload.summary : '');
        setMore(fresh.length > 0 && thisPage < maxPage);
        if (page === 1) {
          setVisibleCount(RESULTS_PER_BATCH);
          setResultsOpen(true);
        } else {
          setVisibleCount((count) => count + RESULTS_PER_BATCH);
          if (!fresh.length) say('No more new results were returned.');
        }
      } catch {
        say('Could not reach this dashboard’s API.', true);
      } finally {
        setSearching(false);
      }
    },
    [query, hits, say, searching],
  );

  const showMoreResults = useCallback(() => {
    if (visibleCount < hits.length) {
      setVisibleCount((count) => Math.min(count + RESULTS_PER_BATCH, hits.length));
    } else if (more) {
      void runSearch(searchPage + 1, searchQuery);
    }
  }, [visibleCount, hits.length, more, runSearch, searchPage, searchQuery]);

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
          body: JSON.stringify(payload),
        });
        const json = await readJson(res);
        if (!res.ok) {
          say(String(json.error || 'The download did not start.'), true);
          void loadStatus();
          return;
        }
        const waiting = Number(json.pending) || 0;
        const sent = Number(json.queued) || payload.urls?.length || 0;
        say(
          json.started === false
            ? `Added ${sent} to the queue — ${waiting} waiting.`
            : typeof json.message === 'string' && json.message.trim()
              ? json.message
              : `${sent} document(s) submitted.`,
        );
        // Keep any new selections made while the request was in flight.
        const submitted = new Set(payload.urls || []);
        setTicked((current) => new Set([...current].filter((url) => !submitted.has(url))));
        void loadStatus();
      } catch {
        say('Could not reach this dashboard’s API.', true);
      } finally {
        setStarting(false);
      }
    },
    [say, loadStatus],
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
  const visibleHits = hits.slice(0, visibleCount);
  const selectableHits = hits.filter((hit) => Boolean(hit.url));

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
          Search for documents, select the ones you need, and save finished PDFs here.
        </p>
      </section>

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
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Search className="h-4 w-4 text-teal-600" /> Find a book
            </h3>
            <p className="mt-1 text-xs text-slate-500">Search by title or subject, then select the books you want.</p>
          </div>
          {ticked.size > 0 && (
            <span className="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-bold text-teal-700">
              {ticked.size} selected
            </span>
          )}
        </div>

        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(event) => { event.preventDefault(); void runSearch(1); }}
        >
          <label htmlFor="scribd-query" className="sr-only">Search Scribd</label>
          <input
            id="scribd-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for a title or subject"
            autoComplete="off"
            className="min-w-0 flex-1 touch-manipulation rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-100 sm:text-sm"
          />
          <button
            type="submit"
            disabled={searching}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:opacity-50 sm:min-h-0 sm:w-auto sm:text-xs"
          >
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {searching ? 'Searching…' : 'Find'}
          </button>
        </form>

        {hasSearched && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0" aria-live="polite">
                <h4 className="text-xs font-bold text-slate-800">Search results</h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  {hits.length
                    ? resultsOpen
                      ? `Showing ${visibleHits.length} of ${hits.length}${searchTotal > hits.length ? ` · ${searchTotal} total` : ''}`
                      : `${hits.length} result${hits.length === 1 ? '' : 's'} hidden`
                    : `No results for “${searchQuery}”`}
                </p>
              </div>
              {hits.length > 0 && (
                <button
                  type="button"
                  aria-expanded={resultsOpen}
                  aria-controls="scribd-search-results"
                  onClick={() => setResultsOpen((open) => !open)}
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  {resultsOpen ? 'Hide results' : 'Show results'}
                  {resultsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>

            {searchName && hits.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-400">{searchName}</p>
            )}

            {hits.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center text-xs text-slate-500">
                Try a different title or a broader subject.
              </div>
            ) : (
              <div id="scribd-search-results" hidden={!resultsOpen} className="mt-3">
                <div className="grid grid-cols-2 gap-2 min-[360px]:grid-cols-3 min-[460px]:grid-cols-4 sm:grid-cols-5 lg:grid-cols-6">
                  {visibleHits.map((hit) => {
                    const selected = Boolean(hit.url) && ticked.has(hit.url);
                    return (
                      <label
                        key={`${hit.id}:${hit.url}`}
                        className={`group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white transition focus-within:ring-2 focus-within:ring-teal-500 focus-within:ring-offset-2 ${
                          selected
                            ? 'border-teal-500 ring-2 ring-teal-100'
                            : hit.url
                              ? 'cursor-pointer border-slate-200 hover:border-teal-300 hover:shadow-sm'
                              : 'cursor-not-allowed border-slate-200 opacity-60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${hit.title}`}
                          checked={selected}
                          disabled={!hit.url}
                          onChange={() => toggle(hit.url)}
                          className="sr-only"
                        />
                        <ResultCover thumbnail={hit.thumbnail} />
                        <span
                          aria-hidden="true"
                          className={`absolute left-1.5 top-1.5 z-10 grid h-5 w-5 place-items-center rounded-md border shadow-sm ${
                            selected ? 'border-teal-600 bg-teal-600 text-white' : 'border-white/80 bg-slate-900/45 text-white'
                          }`}
                        >
                          {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1 px-2 py-2">
                          <span title={hit.title} className="line-clamp-2 min-h-[2.25em] text-[11px] font-semibold leading-tight text-slate-800">
                            {hit.title}
                          </span>
                          <span className="truncate text-[10px] text-slate-500">
                            {[hit.pages ? `${hit.pages} pages` : '', hit.views ? `${hit.views} views` : '']
                              .filter(Boolean).join(' · ') || (hit.url ? 'Scribd document' : 'Link unavailable')}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {(visibleCount < hits.length || more) && (
                  <div className="mt-3 flex justify-center">
                    <button
                      type="button"
                      onClick={showMoreResults}
                      disabled={searching}
                      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:opacity-50"
                    >
                      {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {searching ? 'Loading…' : 'Show more results'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {selectableHits.length > 0 && (
            <button
              type="button"
              onClick={() => setTicked((current) => new Set([...current, ...selectableHits.map((hit) => hit.url)]))}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              <ListChecks className="h-3.5 w-3.5" /> Select all ({selectableHits.length})
            </button>
          )}
          {ticked.size > 0 && (
            <button
              type="button"
              onClick={() => setTicked(new Set())}
              className="inline-flex min-h-9 items-center rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              Clear selection
            </button>
          )}
          <span aria-live="polite" className="text-[11px] font-semibold text-slate-500">
            {ticked.size} selected
          </span>
          <button
            type="button"
            onClick={() => void start({ urls: [...ticked] })}
            disabled={starting || ticked.size === 0}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40 sm:ml-auto sm:min-h-9 sm:w-auto sm:text-xs"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {starting ? 'Submitting…' : running ? `Add to queue (${ticked.size})` : `Download selected (${ticked.size})`}
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
          Tap a file name to save it.
        </p>
      </section>
    </div>
  );
}
