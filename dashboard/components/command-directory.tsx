'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Lock, Search, Terminal } from 'lucide-react';
import { BOT_COMMANDS } from '@/lib/bot-data';
import { scoreCommandQuery } from '@/lib/command-search';

type CategoryFilter = 'all' | 'general' | 'media' | 'vault' | 'admin';

interface CommandDirectoryProps {
  hideOwnerCommands?: boolean;
}

export function CommandDirectory({ hideOwnerCommands = false }: CommandDirectoryProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const visibleCommands = useMemo(
    () =>
      hideOwnerCommands
        ? BOT_COMMANDS.filter((c) => !c.ownerOnly)
        : BOT_COMMANDS,
    [hideOwnerCommands],
  );

  const categories: { id: CategoryFilter; label: string }[] = hideOwnerCommands
    ? [
        { id: 'all', label: `All (${visibleCommands.length})` },
        { id: 'general', label: 'General' },
        { id: 'media', label: 'Media' },
        { id: 'vault', label: 'Vault' },
      ]
    : [
        { id: 'all', label: `All (${visibleCommands.length})` },
        { id: 'general', label: 'General' },
        { id: 'media', label: 'Media' },
        { id: 'vault', label: 'Vault' },
        { id: 'admin', label: 'Admin' },
      ];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inCategory = visibleCommands.filter(
      (cmd) => category === 'all' || cmd.category === category,
    );
    if (!q) return inCategory;
    // Ranked, typo-tolerant matching (ported from sveltekit-embed's docs
    // search). Every query term must match name, an alias, summary or usage.
    return inCategory
      .map((cmd) => ({ cmd, score: scoreCommandQuery(q, cmd) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.cmd);
  }, [visibleCommands, query, category]);

  const copyExample = async (example: string) => {
    try {
      await navigator.clipboard.writeText(example);
      setCopiedCmd(example);
      setTimeout(() => setCopiedCmd(null), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="space-y-3.5">
      <div className="flex flex-col gap-2.5 rounded-2xl border border-ink/10 bg-paper p-3.5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter commands…"
            className="w-full rounded-xl border border-ink/20 bg-ink/5 py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink/40 focus:border-accent focus:bg-paper focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-ink/5 p-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                category === cat.id
                  ? 'bg-paper text-ink shadow-sm'
                  : 'text-ink/60 hover:text-ink'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-ink/10 bg-paper p-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-ink/80">No matches</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((cmd) => {
            const isCopied = copiedCmd === cmd.example;
            return (
              <article
                key={cmd.name}
                className="flex min-w-0 flex-col justify-between rounded-2xl border border-ink/10 bg-paper p-3.5 shadow-sm sm:p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-lg bg-accent/10 px-2 py-0.5 font-mono text-xs font-bold text-accent ring-1 ring-accent/25">
                        <Terminal className="h-3 w-3 text-accent" />.{cmd.name}
                      </span>
                      {cmd.aliases.slice(0, 2).map((alias) => (
                        <span
                          key={alias}
                          className="rounded border border-ink/10 bg-ink/5 px-1.5 py-0.5 font-mono text-[11px] text-ink/60"
                        >
                          .{alias}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-ink/60">
                        {cmd.summary}
                      </span>
                      {cmd.ownerOnly && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent ring-1 ring-accent/25">
                          <Lock className="h-2.5 w-2.5" />
                          {cmd.adminOk ? 'Owner / Admin' : 'Owner'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-2.5 break-all rounded-lg border border-ink/10 bg-ink/5 px-2.5 py-1.5 font-mono text-[11px] text-ink/80">
                    {cmd.usage}
                  </div>
                </div>

                <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2 border-t border-ink/5 pt-2.5">
                  <code className="min-w-0 truncate font-mono text-xs text-ink/60">
                    {cmd.example}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyExample(cmd.example)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-ink/10 bg-ink/5 px-2.5 py-1 text-[11px] font-semibold text-ink/80 transition hover:border-accent/25 hover:bg-accent/10 hover:text-accent"
                  >
                    {isCopied ? (
                      <>
                        <Check className="h-3 w-3 text-accent" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
