import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BookOpen, Home, LifeBuoy, Search, Settings, Terminal } from "lucide-react";
import { WorkspaceShell, PageHead, Badge, Confirm, Tabs, type NavGroup } from "./workspace-shell";
import { ScribdDesk } from "./scribd-desk";
import { SupportDesk } from "./support-desk";
import { Fox } from "./fox";
import { useSession } from "@/lib/session";

export const COMMANDS = [
  { c: "!help", cat: "General", d: "List everything I can do" },
  { c: "!ping", cat: "General", d: "Check that I'm awake" },
  { c: "!sticker", cat: "Media", d: "Turn an image into a sticker" },
  { c: "!dl <link>", cat: "Media", d: "Download a video from a link" },
  { c: "!audio <link>", cat: "Media", d: "Get audio only" },
  { c: "!vault save", cat: "Vault", d: "Save the replied media" },
  { c: "!vault list", cat: "Vault", d: "See your saved media" },
];
const CATS = ["All", "General", "Media", "Vault"] as const;

export function CommandDirectory() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<(typeof CATS)[number]>("All");
  const [copied, setCopied] = useState("");
  const list = COMMANDS.filter((x) => (cat === "All" || x.cat === cat) && (x.c + x.d).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <label className="field mb-4"><Search size={17} /><input aria-label="Search commands" placeholder="search commands" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <Tabs tabs={CATS} value={cat} onChange={setCat} />
      <div className="grid gap-4 sm:grid-cols-2">
        {list.map((x) => (
          <button key={x.c} onClick={() => { navigator.clipboard?.writeText(x.c); setCopied(x.c); setTimeout(() => setCopied(""), 1400); }} className="ink bg-card p-4 text-left">
            <div className="flex items-center justify-between"><span className="font-mono font-semibold">{x.c}</span><span className="eyebrow">{copied === x.c ? "Copied" : x.cat}</span></div>
            <div className="mt-1 text-sm text-muted-foreground">{x.d}</div>
          </button>
        ))}
        {list.length === 0 && <p className="text-sm text-muted-foreground">No commands match.</p>}
      </div>
    </>
  );
}

export function MemberWorkspace() {
  const { session, update } = useSession();
  const navigate = useNavigate();
  const [sec, setSec] = useState("overview");
  const [unlink, setUnlink] = useState(false);
  const [name, setName] = useState(session?.name ?? "");
  const groups: NavGroup[] = [
    { label: "My space", items: [
      { id: "overview", label: "Overview", icon: Home },
      { id: "commands", label: "Commands", icon: Terminal },
      { id: "settings", label: "Settings", icon: Settings },
    ] },
    { label: "More", items: [
      ...(session?.scribd ? [{ id: "scribd", label: "Scribd", icon: BookOpen }] : []),
      { id: "support", label: "Support", icon: LifeBuoy },
    ] },
  ];
  const week = [12, 30, 18, 42, 26, 8, 34];
  const max = Math.max(...week);

  return (
    <WorkspaceShell title="My Workspace" subtitle="Personal workspace" context="My space" groups={groups} active={sec} onSelect={(id) => (id === "support" ? navigate({ to: "/support" }) : setSec(id))}>
      {sec === "overview" && (
        <>
          <div className="ink mb-6 flex items-center gap-4 bg-mint p-6">
            <Fox size={60} className="shrink-0" />
            <div><h1 className="text-2xl sm:text-3xl">hi, {session?.name.split(" ")[0]}</h1><p className="text-sm text-muted-foreground">Everything's running. Send a command in WhatsApp to get started.</p></div>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="ink bg-card p-6">
              <div className="eyebrow">WhatsApp</div>
              <div className="mt-2"><Badge tone="ok">Connected</Badge></div>
              <div className="mt-3 font-mono text-sm">{session?.phone}</div>
            </div>
            <div className="ink bg-card p-6 lg:col-span-2">
              <div className="eyebrow">Commands · last 7 days</div>
              <div className="mt-4 flex h-32 items-end gap-2">
                {week.map((v, i) => (
                  <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <div className="w-full bg-primary" style={{ height: `${(v / max) * 100}%` }} />
                    <span className="font-mono text-[10px] text-muted-foreground">{["M", "T", "W", "T", "F", "S", "S"][i]}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button className="btn" onClick={() => setSec("commands")}>Browse commands</button>
            <button className="btn-ghost" onClick={() => navigate({ to: "/support" })}>Get help</button>
          </div>
        </>
      )}
      {sec === "commands" && <><PageHead eyebrow="My space" title="commands" /><CommandDirectory /></>}
      {sec === "scribd" && session?.scribd && <><PageHead eyebrow="More" title="scribd" /><ScribdDesk /></>}
      {sec === "settings" && (
        <>
          <PageHead eyebrow="My space" title="settings" />
          <div className="ink max-w-xl space-y-6 bg-card p-6">
            <form onSubmit={(e) => { e.preventDefault(); update({ name }); }}>
              <span className="eyebrow">Display name</span>
              <div className="mt-1 flex gap-3"><label className="field flex-1"><input aria-label="Display name" value={name} onChange={(e) => setName(e.target.value)} /></label><button className="btn">Save</button></div>
            </form>
            <div>
              <span className="eyebrow">Linked phone</span>
              <div className="mt-2 flex items-center justify-between gap-3"><span className="font-mono">{session?.phone}</span><button className="btn-ghost text-destructive" onClick={() => setUnlink(true)}>Unlink</button></div>
            </div>
            <button className="text-sm font-semibold underline underline-offset-4" onClick={() => navigate({ to: "/support" })}>Contact support</button>
          </div>
          <Confirm open={unlink} title="unlink phone?" body="You'll need a new pairing code to reconnect." action="Unlink" onClose={() => setUnlink(false)} onConfirm={() => update({ linked: false, phone: undefined })} />
        </>
      )}
    </WorkspaceShell>
  );
}
