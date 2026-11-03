import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Layers, LogOut, Menu, RefreshCw, Settings, X, type LucideIcon } from "lucide-react";
import { initials, useSession } from "@/lib/session";

export type NavItem = { id: string; label: string; icon: LucideIcon; badge?: number };
export type NavGroup = { label: string; items: NavItem[] };

type Props = {
  title: string;
  subtitle: string;
  context: string;
  groups: NavGroup[];
  active: string;
  onSelect: (id: string) => void;
  altView?: { to: "/dashboard" | "/admin"; label: string };
  onRefresh?: () => void;
  children: ReactNode;
};

export function WorkspaceShell(p: Props) {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [account, setAccount] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const all = p.groups.flatMap((g) => g.items);
  const current = all.find((i) => i.id === p.active);

  useEffect(() => {
    if (!drawer) return;
    document.body.style.overflow = "hidden";
    const el = drawerRef.current;
    el?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
      if (e.key === "Tab" && el) {
        const f = el.querySelectorAll<HTMLElement>("button, a");
        const first = f[0], last = f[f.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      menuBtn.current?.focus();
    };
  }, [drawer]);

  const out = () => { signOut(); navigate({ to: "/login" }); };

  const nav = (
    <>
      <div className="flex items-center gap-3 py-5 pl-5 pr-12 lg:pr-5">
        <span className="grid h-9 w-9 place-items-center bg-primary text-primary-foreground"><Layers size={18} /></span>
        <div>
          <div className="font-bold leading-tight">{p.title}</div>
          <div className="text-xs text-muted-foreground">{p.subtitle}</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-4 pb-4">
        {p.groups.map((g) => (
          <div key={g.label} className="ink mt-4 bg-background p-2">
            <div className="eyebrow px-2 pb-2 pt-1">{g.label}</div>
            {g.items.map((i) => (
              <button
                key={i.id}
                onClick={() => { p.onSelect(i.id); setDrawer(false); }}
                aria-current={p.active === i.id ? "page" : undefined}
                className={`flex w-full items-center gap-3 px-3 py-2 text-sm font-medium ${p.active === i.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                <i.icon size={17} />
                <span className="flex-1 text-left">{i.label}</span>
                {!!i.badge && <span className="border border-current px-1.5 font-mono text-[11px] text-primary-foreground">{i.badge}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="ink mx-4 mb-4 flex items-center gap-3 bg-background px-3 py-3">
        <span className="grid h-9 w-9 place-items-center border-2 border-foreground text-xs font-bold">{initials(session?.name ?? "?")}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{session?.name}</div>
          <div className="eyebrow">{session?.role === "owner" ? "Owner" : "Member"}</div>
        </div>
        <button aria-label="Account settings" onClick={() => setAccount(true)} className="p-1.5 hover:bg-muted"><Settings size={16} /></button>
        <button aria-label="Sign out" onClick={out} className="p-1.5 hover:bg-muted"><LogOut size={16} /></button>
      </div>
    </>
  );

  const shortcuts = all.slice(0, 4);

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r bg-background lg:flex">{nav}</aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-foreground/30" onClick={() => setDrawer(false)} />
          <div ref={drawerRef} className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-background animate-in slide-in-from-left">
            <button aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute right-3 top-6 z-10 p-1.5"><X size={18} /></button>
            {nav}
          </div>
        </div>
      )}

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background px-4 py-3 lg:px-8">
          <button ref={menuBtn} aria-label="Open menu" onClick={() => setDrawer(true)} className="p-1.5 lg:hidden"><Menu size={20} /></button>
          <div className="min-w-0 flex-1">
            <div className="eyebrow">{p.context}</div>
            <div className="truncate font-semibold">{current?.label}</div>
          </div>
          {p.altView && <Link to={p.altView.to} className="btn-ghost hidden sm:inline-flex">{p.altView.label}</Link>}
          {p.onRefresh && <button aria-label="Refresh" onClick={p.onRefresh} className="btn-ghost px-2.5"><RefreshCw size={15} /></button>}
          <button aria-label="Account" onClick={() => setAccount(true)} className="grid h-9 w-9 place-items-center border-2 border-foreground text-xs font-bold">{initials(session?.name ?? "?")}</button>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-6 lg:px-8 lg:pb-12">{p.children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden">
        {shortcuts.map((i) => (
          <button key={i.id} onClick={() => p.onSelect(i.id)} className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${p.active === i.id ? "text-foreground" : "text-muted-foreground"}`}>
            <i.icon size={19} />{i.label}
          </button>
        ))}
        {all.length > 4 && (
          <button onClick={() => setDrawer(true)} className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground">
            <Menu size={19} />More
          </button>
        )}
      </nav>

      {account && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Account">
          <div className="absolute inset-0 bg-foreground/30" onClick={() => setAccount(false)} />
          <div className="ink relative w-full max-w-sm bg-background p-6">
            <h2 className="text-xl">account</h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div><dt className="eyebrow">Name</dt><dd>{session?.name}</dd></div>
              <div><dt className="eyebrow">Email</dt><dd className="font-mono">{session?.email}</dd></div>
              <div><dt className="eyebrow">Role</dt><dd>{session?.role}</dd></div>
            </dl>
            <div className="mt-6 flex gap-2">
              <button className="btn flex-1" onClick={out}><LogOut size={15} />Sign out</button>
              <button className="btn-ghost" onClick={() => setAccount(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function PageHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="mt-1 text-3xl sm:text-4xl">{title}</h1>
      </div>
      {right}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly T[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-6 overflow-x-auto">
      <div className="seg">
        {tabs.map((t) => (
          <button key={t} aria-pressed={value === t} onClick={() => onChange(t)}>{t}</button>
        ))}
      </div>
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "ok" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  const c = {
    ok: "border-success text-success",
    warn: "border-warning text-warning",
    bad: "border-destructive text-destructive",
    neutral: "border-foreground text-foreground",
  }[tone];
  return <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${c}`}>{children}</span>;
}

export function Confirm({ open, title, body, action, onConfirm, onClose }: { open: boolean; title: string; body: string; action: string; onConfirm: () => void; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-foreground/30" onClick={onClose} />
      <div className="ink relative w-full max-w-sm bg-background p-6">
        <h2 className="text-xl">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn bg-destructive" onClick={() => { onConfirm(); onClose(); }}>{action}</button>
        </div>
      </div>
    </div>
  );
}
