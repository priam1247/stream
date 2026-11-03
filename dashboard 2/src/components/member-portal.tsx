import { useState } from "react";
import { Archive, BookOpen, Phone, Server, Terminal } from "lucide-react";
import { WorkspaceShell, PageHead, Badge, type NavGroup } from "./workspace-shell";
import { CommandDirectory } from "./member-workspace";
import { ScribdDesk } from "./scribd-desk";

/** Owner-only multi-number tools view at /dashboard. */
export function MemberPortal() {
  const [sec, setSec] = useState("numbers");
  const groups: NavGroup[] = [
    { label: "Tools", items: [
      { id: "numbers", label: "Numbers", icon: Phone },
      { id: "commands", label: "Commands", icon: Terminal },
      { id: "vault", label: "Media vault", icon: Archive },
    ] },
    { label: "More", items: [
      { id: "scribd", label: "Scribd", icon: BookOpen },
      { id: "server", label: "Server", icon: Server },
    ] },
  ];
  return (
    <WorkspaceShell title="Control Room" subtitle="Member tools" context="Member view" groups={groups} active={sec} onSelect={setSec} altView={{ to: "/admin", label: "Owner console" }}>
      {sec === "numbers" && (
        <>
          <PageHead eyebrow="Fleet" title="numbers" />
          <div className="grid gap-4 sm:grid-cols-3">
            {[["+48 512 300 118", "Main", "ok"], ["+48 512 400 211", "Backup", "bad"], ["+44 7700 900 412", "UK", "ok"]].map(([p, l, t]) => (
              <div key={p} className="ink bg-card p-5">
                <div className="font-mono">{p}</div>
                <div className="mt-1 text-xs text-muted-foreground">{l}</div>
                <div className="mt-3"><Badge tone={t as "ok" | "bad"}>{t === "ok" ? "Connected" : "Offline"}</Badge></div>
              </div>
            ))}
          </div>
        </>
      )}
      {sec === "commands" && <><PageHead eyebrow="Tools" title="commands" /><CommandDirectory /></>}
      {sec === "vault" && (
        <>
          <PageHead eyebrow="Tools" title="media vault" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {["sunset.jpg", "meme.mp4", "voice.ogg", "receipt.pdf"].map((f) => <div key={f} className="ink grid aspect-square place-items-center bg-card font-mono text-xs">{f}</div>)}
          </div>
        </>
      )}
      {sec === "scribd" && <><PageHead eyebrow="More" title="scribd" /><ScribdDesk /></>}
      {sec === "server" && (
        <>
          <PageHead eyebrow="More" title="server" />
          <div className="grid gap-4 sm:grid-cols-3">
            {[["Bridge", "Reachable"], ["Uptime", "4d 11h"], ["Queue", "3 jobs"]].map(([k, v]) => <div key={k} className="ink bg-card p-5"><div className="eyebrow">{k}</div><div className="mt-2 font-mono">{v}</div></div>)}
          </div>
        </>
      )}
    </WorkspaceShell>
  );
}
