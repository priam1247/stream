import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Fox } from "./fox";
import { homeFor, useSession, type Role } from "@/lib/session";

export function Loading() {
  return <div className="grid min-h-screen place-items-center"><Fox size={56} className="animate-pulse motion-reduce:animate-none" /></div>;
}

/** Requires a session; optionally a role. Members hitting owner pages get a 403. */
export function Guard({ role, children }: { role?: Role; children: ReactNode }) {
  const { session, ready } = useSession();
  const navigate = useNavigate();
  useEffect(() => { if (ready && !session) navigate({ to: "/login", replace: true }); }, [ready, session]);
  if (!ready || !session) return <Loading />;
  if (role && session.role !== role) {
    return (
      <div className="grid min-h-screen place-items-center px-4 text-center">
        <div className="ink bg-background p-8">
          <div className="font-mono text-sm text-muted-foreground">403</div>
          <h1 className="mt-2 text-2xl">owners only</h1>
          <Link to={homeFor(session)} className="btn mt-6">Back to my space</Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
