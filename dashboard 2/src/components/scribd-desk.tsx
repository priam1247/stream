import { useEffect, useState } from "react";
import { Download, Search } from "lucide-react";
import { Badge, Tabs } from "./workspace-shell";

const TABS = ["Search", "Queue", "Files"] as const;
type Job = { id: number; title: string; progress: number };

export function ScribdDesk() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Search");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const [queue, setQueue] = useState<Job[]>([{ id: 1, title: "Organic Chemistry Notes", progress: 64 }]);
  const [files, setFiles] = useState(["Linear Algebra Primer.pdf", "Contract Law Outline.pdf"]);

  useEffect(() => {
    const t = setInterval(() => {
      setQueue((qs) => {
        const done = qs.filter((j) => j.progress >= 100);
        if (done.length) setFiles((f) => [...done.map((d) => d.title + ".pdf"), ...f]);
        return qs.filter((j) => j.progress < 100).map((j) => ({ ...j, progress: Math.min(100, j.progress + 9) }));
      });
    }, 1500);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === "Search" && (
        <div className="ink bg-card p-6">
          <form onSubmit={(e) => { e.preventDefault(); setResults(q ? [1, 2, 3].map((n) => `${q} — part ${n}`) : []); }} className="flex flex-col gap-3 sm:flex-row">
            <label className="field flex-1"><Search size={17} /><input aria-label="Search Scribd" placeholder="search documents" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <button className="btn">Search</button>
          </form>
          {results?.length === 0 && <p className="mt-6 text-sm text-muted-foreground">Type something to search.</p>}
          <ul className="mt-4 divide-y">
            {results?.map((r) => (
              <li key={r} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span>{r}</span>
                <button className="btn-ghost" onClick={() => { setQueue((x) => [...x, { id: Date.now(), title: r, progress: 0 }]); setTab("Queue"); }}>Queue</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === "Queue" && (
        <div className="ink bg-card p-6">
          {queue.length === 0 ? <p className="text-sm text-muted-foreground">Queue is empty.</p> : (
            <ul className="space-y-4">
              {queue.map((j) => (
                <li key={j.id}>
                  <div className="flex justify-between text-sm"><span>{j.title}</span><span className="font-mono">{j.progress}%</span></div>
                  <div className="mt-2 h-1.5 bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${j.progress}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === "Files" && (
        <div className="ink bg-card p-6">
          <ul className="divide-y">
            {files.map((f) => (
              <li key={f} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="truncate">{f}</span>
                <span className="flex items-center gap-2"><Badge tone="ok">Ready</Badge><button aria-label={`Download ${f}`} className="btn-ghost px-2"><Download size={15} /></button></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
