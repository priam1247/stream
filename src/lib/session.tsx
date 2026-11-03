import type React from "react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Role = "owner" | "member";
export type Session = {
  name: string;
  email: string;
  role: Role;
  linked: boolean;
  phone?: string | undefined;
  scribd: boolean;
};

type Ctx = {
  session: Session | null;
  ready: boolean;
  signIn: (s: Session) => void;
  update: (p: Partial<Session>) => void;
  signOut: () => void;
};

// Shared across hot reloads so provider and consumers always use the same context.
const g = globalThis as { __zafarSessionCtx?: React.Context<Ctx | null> };
const SessionCtx = (g.__zafarSessionCtx ??= createContext<Ctx | null>(null));
const KEY = "zafar-demo-session";

/** Demo session store (browser only). Swap for real auth later. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setSession(JSON.parse(raw));
    } catch {}
    setReady(true);
  }, []);
  const persist = (s: Session | null) => {
    setSession(s);
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  };
  return (
    <SessionCtx.Provider
      value={{
        session,
        ready,
        signIn: persist,
        update: (p) => session && persist({ ...session, ...p }),
        signOut: () => persist(null),
      }}
    >
      {children}
    </SessionCtx.Provider>
  );
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession outside provider");
  return c;
}

export function homeFor(s: Session | null): "/login" | "/admin" | "/dashboard" {
  if (!s) return "/login";
  return s.role === "owner" ? "/admin" : "/dashboard";
}

export function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}
