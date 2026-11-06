'use client';

import { useState } from 'react';
import { BookOpenCheck, Check, Copy, Database, Film } from 'lucide-react';
import { METADATA_SOURCES, VAULT_STATS } from '@/lib/bot-data';
import { SectionNav } from './section-nav';

type VaultPage = 'papers' | 'providers';
const PAGES: { id: VaultPage; label: string }[] = [
  { id: 'papers', label: 'Papers' },
  { id: 'providers', label: 'Providers' },
];

export function MediaVaultDesk() {
  const [page, setPage] = useState<VaultPage>('papers');
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);

  const copyQuery = async (q: string) => {
    try {
      await navigator.clipboard.writeText(q);
      setCopiedQuery(q);
      setTimeout(() => setCopiedQuery(null), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="font-display px-0.5 text-[28px] font-semibold tracking-tight text-ink">Vault</h1>
      <SectionNav label="Vault pages" items={PAGES} value={page} onChange={setPage} />
      {page === 'papers' && <section className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700 ring-1 ring-accent-200">
              <BookOpenCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-ink sm:text-base">
                {VAULT_STATS.institution} Paper Vault
              </h2>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <Database className="h-3 w-3 text-accent-600" />
                <span className="truncate">{VAULT_STATS.storageBackend}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-accent-200 bg-accent-50 px-3.5 py-2 text-right">
            <div className="font-mono text-lg font-extrabold text-accent-800 tabular-nums sm:text-xl">
              {VAULT_STATS.totalPapers.toLocaleString()}
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-accent-700">
              PDFs Indexed
            </div>
          </div>
        </div>

        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {VAULT_STATS.sampleQueries.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => copyQuery(q)}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-xl border border-line bg-wash px-2.5 py-1.5 font-mono text-xs font-medium text-ink-soft transition hover:border-accent-200 hover:bg-accent-50 hover:text-accent-800"
            >
              {copiedQuery === q ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-accent-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0 text-faint" />
              )}
              <span className="truncate">{q}</span>
            </button>
          ))}
        </div>
      </section>}

      {page === 'providers' && <section className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink sm:text-base">
            <Film className="h-4 w-4 text-accent-600" />
            Providers ({METADATA_SOURCES.length})
          </h2>
          <span className="rounded-full bg-wash px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-muted">
            Listed
          </span>
        </div>

        <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {METADATA_SOURCES.map((src) => (
            <div
              key={src.id}
              className="flex min-w-0 flex-col items-start justify-between gap-1 rounded-xl border border-line bg-wash px-3 py-2.5 sm:flex-row sm:items-center sm:gap-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-faint" />
                <span className="whitespace-nowrap font-mono text-[11px] font-bold text-ink">
                  {src.label}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[10px] font-semibold uppercase text-muted">
                {src.scope}
              </span>
            </div>
          ))}
        </div>
      </section>}
    </div>
  );
}
