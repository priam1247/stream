'use client';

import { useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, LogOut, Mail, ShieldCheck, X } from 'lucide-react';
import { AuthUser, UserQuota } from '@/lib/types';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  user: AuthUser;
  quota: UserQuota | null;
  onUpdateName: (name: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function AccountModal({
  open,
  onClose,
  user,
  quota,
  onUpdateName,
  onSignOut,
}: AccountModalProps) {
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(user.name);
  }, [open, user.name]);

  if (!open) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onUpdateName(name.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-3.5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-ink/10 bg-paper p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 font-mono text-sm font-bold uppercase text-accent ring-1 ring-accent/25">
              {(user.name || user.email).slice(0, 2)}
            </div>
            <div className="min-w-0">
              <h2
                id="account-modal-title"
                className="truncate text-base font-bold text-ink"
              >
                {user.name}
              </h2>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink/60">
                <Mail className="h-3 w-3 shrink-0 text-accent" />
                <span className="truncate font-mono">{user.email}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-ink/40 hover:bg-ink/5 hover:text-ink/80"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold text-accent ring-1 ring-accent/25">
            <CheckCircle2 className="h-3 w-3" />
            Verified
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-ink/5 px-2.5 py-0.5 text-[11px] font-semibold text-ink/80">
            <ShieldCheck className="h-3 w-3 text-accent" />
            {user.isAdmin ? 'Admin' : 'Member'}
          </span>
        </div>

        {quota && (
          <div className="mt-4 rounded-xl border border-ink/10 bg-ink/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink/80">
              <BookOpen className="h-3.5 w-3.5 text-accent" />
              Daily Quota
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-ink/10 bg-paper p-2.5">
                <div className="text-ink/60">Papers</div>
                <div className="mt-0.5 font-mono text-base font-bold text-accent tabular-nums">
                  {quota.papers_left}/{quota.papers_limit}
                </div>
              </div>
              <div className="rounded-lg border border-ink/10 bg-paper p-2.5">
                <div className="text-ink/60">Books</div>
                <div className="mt-0.5 font-mono text-base font-bold text-accent tabular-nums">
                  {quota.books_left}/{quota.books_limit}
                </div>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="account-display-name"
              className="mb-1 block text-xs font-medium text-ink/80"
            >
              Name
            </label>
            <input
              id="account-display-name"
              type="text"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-ink/20 bg-paper px-3.5 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/15"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>

            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-paper shadow-sm transition hover:bg-accent disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
