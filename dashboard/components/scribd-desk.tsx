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
  Heart,
  Clock3,
  Library,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { authHeaders } from '@/lib/client-session';
import { normalizeScribdHit, safeScribdThumbnail, scribdDocumentId } from '@/lib/scribd-search';
import { filesFromJob } from '@/lib/scribd-job';
import type { ScribdPage } from '@/lib/control-room';
import { SectionNav } from './section-nav';
import type {
  ScribdFindPayload,
  ScribdHit,
  ScribdStatusPayload,
} from '@/lib/scribd-types';

const POLL_MS = 2_500;
const RESULTS_PER_BATCH = 12;
const PAGES: { id: ScribdPage; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'queue', label: 'Queue' },
  { id: 'files', label: 'Files' },
];

function ResultCover({ thumbnail }: { thumbnail?: string }) {
  const [failedSrc, setFailedSrc] = useState('');
  const cover = safeScribdThumbnail(thumbnail);
  const src = cover ? `/api/scribd/thumb?url=${encodeURIComponent(cover)}` : undefined;

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

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function restoreHits(value: unknown): Map<string, ScribdHit> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.slice(0, 200).flatMap((raw) => {
    const hit = normalizeScribdHit(raw);
    return hit && /^\d{1,20}$/.test(hit.id) && scribdDocumentId(hit.url) === hit.id ? [[hit.id, hit] as const] : [];
  }));
}

/** Device-local preferences are separated by account and contain no credentials. */
export function ScribdDesk({ bottomNav = false, active = true, page: controlledPage, onPageChange }: {
  bottomNav?: boolean;
  active?: boolean;
  page?: ScribdPage;
  onPageChange?: (page: ScribdPage) => void;
} = {}) {
  const [localPage, setLocalPage] = useState<ScribdPage>('search');
  const page = controlledPage ?? localPage;
  const changePage = onPageChange ?? setLocalPage;
  const [status, setStatus] = useState<ScribdStatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
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
  const [ticked, setTicked] = useState<Map<string, ScribdHit>>(new Map());
  const [more, setMore] = useState(false);
  const [favorites, setFavorites] = useState<Map<string, ScribdHit>>(new Map());
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [sortBy, setSortBy] = useState<'relevance' | 'title' | 'pages'>('relevance');
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState<'all' | 'server' | 'drime'>('all');
  const [fileQuery, setFileQuery] = useState('');

  const [starting, setStarting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const noticeTimer = useRef<number | null>(null);
  const statusBusy = useRef(false);

  const say = useCallback((text: string, bad = false) => {
    setNotice({ text, bad });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), bad ? 9000 : 5000);
  }, []);

  const running = status?.state === 'running';

  const loadStatus = useCallback(async () => {
    if (statusBusy.current) return;
    statusBusy.current = true;
    try {
      const res = await fetch('/api/scribd/status', {
        headers: authHeaders(),
        cache: 'no-store',
      });
      const json = await readJson(res);
      if (!res.ok) {
        setStatus(null);
        setStatusError(String(json.error || 'The Scribd server did not answer.'));
        return;
      }
      setStatus({ ...json, items: Array.isArray(json.items) ? json.items : [] } as unknown as ScribdStatusPayload);
      setStatusError(null);
    } catch {
      setStatus(null);
      setStatusError('Could not reach the dashboard’s Scribd API.');
    } finally {
      statusBusy.current = false;
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
        if (!res.ok) {
          if (active) setIsAdmin(false);
          return;
        }
        const json = (await res.json()) as { user?: { isAdmin?: boolean; email?: string } };
        if (!active) return;
        setIsAdmin(Boolean(json.user?.isAdmin));
        if (typeof json.user?.email === 'string' && json.user.email.trim()) {
          const key = `zafar_scribd_preferences_v1:${json.user.email.trim().toLowerCase()}`;
          try {
            const saved = JSON.parse(localStorage.getItem(key) || '{}') as { selected?: unknown; favorites?: unknown; history?: unknown };
            const restored = restoreHits(saved.selected);
            setTicked((current) => new Map([...current, ...[...restored].filter(([id]) => !current.has(id))].slice(0, 200)));
            setFavorites(restoreHits(saved.favorites));
            setSearchHistory(Array.isArray(saved.history) ? saved.history.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, 8) : []);
          } catch { /* Storage can be disabled or corrupt. The desk still works. */ }
          setStorageKey(key);
        }
      } catch {
        if (active) setIsAdmin(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ selected: [...ticked.values()], favorites: [...favorites.values()], history: searchHistory }));
    } catch { /* Private browsing or a full device must not break the queue. */ }
  }, [storageKey, ticked, favorites, searchHistory]);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadStatus();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadStatus();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, loadStatus]);

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
          setSearchHistory((previous) => [words, ...previous.filter((item) => item.toLowerCase() !== words.toLowerCase())].slice(0, 8));
          setShowSaved(false);
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
    const total = showSaved ? favorites.size : hits.length;
    if (visibleCount < total) {
      setVisibleCount((count) => Math.min(count + RESULTS_PER_BATCH, total));
    } else if (!showSaved && more) {
      void runSearch(searchPage + 1, searchQuery);
    }
  }, [visibleCount, hits.length, favorites.size, showSaved, more, runSearch, searchPage, searchQuery]);

  const toggle = useCallback((hit: ScribdHit) => {
    if (!ticked.has(hit.id) && ticked.size >= 200) { say('Select at most 200 documents at a time.', true); return; }
    setTicked((current) => {
      const next = new Map(current);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.set(hit.id, hit);
      return next;
    });
  }, [ticked, say]);

  const toggleFavorite = useCallback((hit: ScribdHit) => {
    setFavorites((current) => {
      const next = new Map(current);
      if (next.has(hit.id)) next.delete(hit.id);
      else if (next.size < 200) next.set(hit.id, hit);
      return next;
    });
  }, []);

  const start = useCallback(async () => {
    const docs = [...ticked.values()].map(({ id, title, pages, url }) => ({ id, title, pages, url }));
    if (!docs.length || isAdmin !== true) return;
    setStarting(true);
    try {
      const res = await fetch('/api/scribd/run', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ docs }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        say(String(json.error || 'The download did not start.'), true);
        void loadStatus();
        return;
      }
      say(typeof json.message === 'string' ? json.message : 'Request sent. Check the Queue tab.');
      // The service ignores IDs already present in its history. Retain those
      // selections and any new choices made while the request was in flight.
      const submitted = new Set(docs.map((doc) => doc.id));
      const accepted = new Set(Array.isArray(json.acceptedIds) ? json.acceptedIds.map(String) : []);
      setTicked((current) => new Map([...current].filter(([id]) => !submitted.has(id) || !accepted.has(id))));
      void loadStatus();
    } catch {
      say('Could not reach this dashboard’s API.', true);
    } finally {
      setStarting(false);
    }
  }, [ticked, isAdmin, say, loadStatus]);

  const resetJob = useCallback(async () => {
    if (!window.confirm('Cancel the running download and all waiting downloads?')) return;
    setResetting(true);
    try {
      const res = await fetch('/api/scribd/reset', { method: 'POST', headers: authHeaders() });
      const json = await readJson(res);
      if (!res.ok) {
        say(String(json.error || 'Cancellation could not be requested.'), true);
        return;
      }
      say(json.requested ? 'Cancellation requested. The running job may take a moment to stop.' : 'No cancellation was reported.');
      void loadStatus();
    } catch {
      say('Could not reach this dashboard’s API.', true);
    } finally {
      setResetting(false);
    }
  }, [say, loadStatus]);

  const clearQueue = useCallback(async () => {
    if (!window.confirm('Clear waiting jobs and queue history? Completed items will disappear from this list, but their files remain. A running job will continue.')) return;
    setClearing(true);
    try {
      const res = await fetch('/api/scribd/clear', { method: 'POST', headers: authHeaders() });
      const json = await readJson(res);
      if (!res.ok) {
        say(String(json.error || 'The queue could not be cleared.'), true);
        return;
      }
      say('Queue history and waiting jobs cleared.');
      void loadStatus();
    } catch {
      say('Could not reach this dashboard’s API.', true);
    } finally {
      setClearing(false);
    }
  }, [say, loadStatus]);

  const fileUrl = useCallback((name: string) => `/api/scribd/file?name=${encodeURIComponent(name)}`, []);
  const files = useMemo(() => filesFromJob(status?.items || []), [status]);
  const shownFiles = files.filter((file) => (fileFilter === 'all' || file.source === fileFilter) && `${file.name} ${file.title}`.toLowerCase().includes(fileQuery.trim().toLowerCase()));
  const displayHits = useMemo(() => {
    const list = showSaved ? [...favorites.values()] : [...hits];
    if (sortBy === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sortBy === 'pages') list.sort((a, b) => b.pages - a.pages);
    return list;
  }, [showSaved, favorites, hits, sortBy]);
  const visibleHits = displayHits.slice(0, visibleCount);
  const selectableHits = displayHits.filter((hit) => Boolean(hit.url));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 px-0.5">
          <div className="flex items-center gap-2">
            <Library className="h-5 w-5 text-teal-600" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-950">Scribd</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
            <span
              className={`rounded-full px-2 py-0.5 ${
                status?.panelOnline
                  ? 'bg-teal-50 text-teal-700'
                  : statusError ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {status?.panelOnline ? 'server online' : statusError ? 'server unavailable' : 'checking server…'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 ${
                running ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {running ? 'working…' : status?.state || 'unknown'}
            </span>
            <button
              type="button"
              onClick={() => void loadStatus()}
              aria-label="Refresh Scribd status"
              title="Refresh"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
      </div>
      <SectionNav label="Scribd pages" items={PAGES} value={page} onChange={changePage} />

      {statusError && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800">
          {statusError}
        </div>
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

      {page === 'search' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Search className="h-4 w-4 text-teal-600" /> Find a book
            </h2>
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

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setShowSaved((current) => !current); setVisibleCount(RESULTS_PER_BATCH); setResultsOpen(true); }} aria-pressed={showSaved} className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold ${showSaved ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600'}`}><Heart className={`h-3.5 w-3.5 ${showSaved ? 'fill-current text-teal-600' : ''}`} /> Favourites ({favorites.size})</button>
          {storageKey && <span className="text-[11px] text-slate-400">Saved on this device</span>}
        </div>
        {searchHistory.length > 0 && <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-1"><Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-400" /><span className="shrink-0 text-[11px] text-slate-500">Recent:</span>{searchHistory.slice(0, 5).map((word) => <button key={word} type="button" disabled={searching} onClick={() => { setQuery(word); void runSearch(1, word); }} className="min-h-8 shrink-0 rounded-full bg-slate-100 px-2.5 text-[11px] font-medium text-slate-600 hover:bg-teal-50 hover:text-teal-800">{word}</button>)}<button type="button" onClick={() => setSearchHistory([])} className="min-h-8 shrink-0 px-1 text-[11px] font-semibold text-slate-500 underline">Clear</button></div>}

        {(hasSearched || showSaved) && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0" aria-live="polite">
                <h4 className="text-xs font-bold text-slate-800">{showSaved ? 'Favourite books' : 'Search results'}</h4>
                <p className="mt-1 text-[11px] text-slate-500">
                  {displayHits.length
                    ? resultsOpen
                      ? `Showing ${visibleHits.length} of ${displayHits.length}${!showSaved && searchTotal > displayHits.length ? ` · ${searchTotal} total` : ''}`
                      : `${displayHits.length} result${displayHits.length === 1 ? '' : 's'} hidden`
                    : showSaved ? 'No favourites saved on this device' : `No results for “${searchQuery}”`}
                </p>
              </div>
              {displayHits.length > 0 && (
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

            {!showSaved && searchName && displayHits.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-400">{searchName}</p>
            )}

            {displayHits.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center text-xs text-slate-500">
                {showSaved ? 'Save a book from search results to find it here later.' : 'Try a different title or a broader subject.'}
              </div>
            ) : (
              <div id="scribd-search-results" hidden={!resultsOpen} className="mt-3">
                <div className="mb-2 flex items-center justify-end gap-2"><label htmlFor="scribd-sort" className="text-[11px] text-slate-500">Sort loaded results</label><select id="scribd-sort" value={sortBy} onChange={(event) => setSortBy(event.target.value as 'relevance' | 'title' | 'pages')} className="min-h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700"><option value="relevance">Original order</option><option value="title">Title</option><option value="pages">Most pages</option></select></div>
                <div className="grid grid-cols-2 gap-2 min-[360px]:grid-cols-3 min-[460px]:grid-cols-4 sm:grid-cols-5 lg:grid-cols-6">
                  {visibleHits.map((hit) => {
                    const selected = Boolean(hit.url) && ticked.has(hit.id);
                    return (
                      <div key={`${hit.id}:${hit.url}`} className="relative min-w-0">
                      <label
                        className={`group relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-white transition focus-within:ring-2 focus-within:ring-teal-500 focus-within:ring-offset-2 ${
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
                          onChange={() => toggle(hit)}
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
                      <button type="button" aria-label={`${favorites.has(hit.id) ? 'Remove' : 'Save'} ${hit.title} ${favorites.has(hit.id) ? 'from favourites' : 'to favourites'}`} onClick={() => toggleFavorite(hit)} className={`absolute right-1.5 top-1.5 z-10 grid h-8 w-8 place-items-center rounded-lg border border-white/80 shadow-sm ${favorites.has(hit.id) ? 'bg-white text-rose-500' : 'bg-slate-900/50 text-white'}`}><Heart className={`h-4 w-4 ${favorites.has(hit.id) ? 'fill-current' : ''}`} /></button>
                      </div>
                    );
                  })}
                </div>
                {(visibleCount < displayHits.length || (!showSaved && more)) && (
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
              onClick={() => setTicked((current) => new Map([...current, ...selectableHits.map((hit) => [hit.id, hit] as const)].slice(0, 200)))}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
            >
              <ListChecks className="h-3.5 w-3.5" /> Select all ({selectableHits.length})
            </button>
          )}
          {ticked.size > 0 && (
            <button
              type="button"
              onClick={() => setTicked(new Map())}
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
            onClick={() => void start()}
            disabled={starting || ticked.size === 0 || isAdmin !== true}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40 sm:ml-auto sm:min-h-9 sm:w-auto sm:text-xs"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {starting ? 'Submitting…' : running ? `Add to queue (${ticked.size})` : `Download selected (${ticked.size})`}
          </button>
        </div>
        {ticked.size > 0 && <details className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2"><summary className="cursor-pointer text-xs font-semibold text-slate-700">Review selected books ({ticked.size})</summary><ul className="mt-2 max-h-44 divide-y divide-slate-200 overflow-y-auto">{[...ticked.values()].map((hit) => <li key={hit.id} className="flex items-center justify-between gap-2 py-2"><span className="min-w-0 break-words text-xs text-slate-600">{hit.title}</span><button type="button" onClick={() => toggle(hit)} aria-label={`Remove ${hit.title} from selection`} className="min-h-8 shrink-0 text-xs font-semibold text-rose-700">Remove</button></li>)}</ul></details>}
        {isAdmin === false && (
          <p className="mt-2 text-[11px] text-slate-500">Only administrators can start or cancel downloads.</p>
        )}
      </section>}

      {page === 'queue' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <BookOpen className="h-4 w-4 text-teal-600" /> Download queue
          </h2>
          {status && (
            <span className="text-[11px] font-semibold text-slate-500">
              {status.active || 0} active · {status.finished || 0} finished · {status.failed || 0} failed
            </span>
          )}
        </div>

        {isAdmin && status && status.items.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {running && (
              <button
                type="button"
                onClick={() => void resetJob()}
                disabled={resetting || clearing}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-rose-200 px-3 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                Cancel downloads
              </button>
            )}
            <button
              type="button"
              onClick={() => void clearQueue()}
              disabled={clearing || resetting}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Clear queue
            </button>
          </div>
        )}

        {!status ? (
          <p className="mt-3 text-xs text-slate-500">{statusError ? 'Job status is unavailable.' : 'Checking job status…'}</p>
        ) : status.items.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">No downloads in the queue yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-100">
            {status.items.map((item, index) => {
              const percent = item.total ? Math.min(100, Math.round((item.done / item.total) * 100)) : 0;
              return (
                <li key={`${item.id}:${index}`} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-xs font-semibold text-slate-800">{item.title}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                      item.status === 'done' ? 'bg-teal-50 text-teal-700'
                        : item.status === 'failed' || item.status === 'cancelled' ? 'bg-rose-50 text-rose-700'
                          : item.status === 'running' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {item.status}
                    </span>
                  </div>
                  {(item.status === 'running' || item.status === 'queued') && item.total > 0 && (
                    <div className="mt-2">
                      <div
                        role="progressbar"
                        aria-label={`Progress for ${item.title}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                        className="h-1.5 overflow-hidden rounded-full bg-slate-100"
                      >
                        <div className="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${percent}%` }} />
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">{item.done} / {item.total} pages reported</p>
                    </div>
                  )}
                  {item.status === 'running' && !item.total && (
                    <p className="mt-1 text-[11px] text-slate-500">Working; page count is not available yet.</p>
                  )}
                  {item.detail && item.status !== 'done' && item.detail !== item.error && (
                    <p className="mt-1 break-words text-[11px] text-slate-500">{item.detail}</p>
                  )}
                  {item.error && <p className="mt-1 break-words text-[11px] text-rose-700">{item.error}</p>}
                  {item.recovered && <p className="mt-1 text-[11px] text-slate-500">Recovered from an earlier run.</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>}

      {page === 'files' && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <FileText className="h-4 w-4 text-teal-600" /> Finished PDFs
          <span className="font-mono text-[11px] font-normal text-slate-500 tabular-nums">{files.length}</span>
        </h2>
        {files.length > 0 && <div className="mt-3 flex flex-wrap gap-2"><input type="search" aria-label="Search finished PDFs" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Find a finished PDF" className="min-h-10 min-w-0 flex-1 basis-40 rounded-xl border border-slate-200 bg-slate-50 px-3 text-base text-slate-900 outline-none focus:border-teal-400 sm:text-sm" /><select aria-label="Filter PDF location" value={fileFilter} onChange={(event) => setFileFilter(event.target.value as 'all' | 'server' | 'drime')} className="min-h-10 rounded-xl border border-slate-200 bg-white px-2 text-xs text-slate-700"><option value="all">All locations</option><option value="server">On server</option><option value="drime">Drime</option></select></div>}
        {!status ? (
          <p className="mt-2 text-xs text-slate-500">{statusError ? 'Files are unavailable while the server is offline.' : 'Checking for finished files…'}</p>
        ) : files.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No finished PDFs reported by the server.</p>
        ) : shownFiles.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">No finished PDFs match this filter.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {shownFiles.map((file) => {
              const info = [file.source === 'drime' ? 'Stored in Drime' : 'On server', file.bytes ? bytesText(file.bytes) : '', file.when ? whenText(file.when) : ''].filter(Boolean).join(' · ');
              return (
                <li key={`${file.id}:${file.name}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    {file.source === 'server' ? (
                      <a href={fileUrl(file.name)} download={file.name} className="block truncate text-xs font-semibold text-slate-900 underline-offset-2 hover:text-teal-700 hover:underline">
                        {file.name}
                      </a>
                    ) : (
                      <span className="block truncate text-xs font-semibold text-slate-900">{file.name}</span>
                    )}
                    <p className="text-[11px] text-slate-500 tabular-nums">{info}</p>
                    {file.source === 'drime' && !file.shareUrl && (
                      <p className="mt-0.5 text-[11px] text-slate-500">No share link was supplied; open your Drime folder to find this file.</p>
                    )}
                  </div>
                  {file.source === 'server' ? (
                    <a href={fileUrl(file.name)} download={file.name} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700">
                      <Download className="h-3.5 w-3.5" /> Save
                    </a>
                  ) : (
                    <a href={file.shareUrl || 'https://app.drime.cloud/'} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700">
                      Open Drime
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>}
      {page === 'search' && ticked.size > 0 && <div role="status" className={`fixed inset-x-3 z-[35] mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl border border-teal-200 bg-white/95 p-2.5 shadow-[0_8px_35px_rgba(15,23,42,0.18)] backdrop-blur-md ${bottomNav ? 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] sm:bottom-4' : 'bottom-4'}`}>
        <div className="min-w-0 pl-1"><p className="text-sm font-bold text-slate-900">{ticked.size} selected</p><p className="text-[11px] text-slate-500">Ready in your selection</p></div>
        <button type="button" aria-label="Submit selected books" onClick={() => void start()} disabled={starting || isAdmin !== true} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-teal-600 px-3.5 text-xs font-bold text-white disabled:opacity-40"><Download className="h-4 w-4" /> {starting ? 'Submitting…' : 'Queue'}</button>
      </div>}
    </div>
  );
}
