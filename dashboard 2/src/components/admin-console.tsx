import { useState } from "react";
import {
  Activity, AlertTriangle, BookOpen, CheckCircle2, Eye, EyeOff, Home, Inbox, MessageCircle, Plus, Power, Trash2, Users, XCircle,
} from "lucide-react";
import { WorkspaceShell, PageHead, Tabs, Badge, Confirm, type NavGroup } from "./workspace-shell";
import { ScribdDesk } from "./scribd-desk";
import { SupportDesk } from "./support-desk";
import { PairingCodeBanner } from "./pairing-code-banner";

type Section = "home" | "whatsapp" | "scribd" | "members" | "reports" | "activity";

const alerts = [
  { sev: "bad" as const, text: "Number +48 512 *** 211 disconnected", go: "whatsapp" as Section, cat: "Numbers" },
  { sev: "warn" as const, text: "2 members waiting for approval", go: "members" as Section, cat: "Members" },
  { sev: "warn" as const, text: "Scribd queue slower than usual", go: "scribd" as Section, cat: "Scribd" },
];

export function AdminConsole() {
  const [sec, setSec] = useState<Section>("home");
  const [checked, setChecked] = useState(new Date());
  const groups: NavGroup[] = [
    { label: "Workspace", items: [
      { id: "home", label: "Home", icon: Home },
      { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
      { id: "scribd", label: "Scribd", icon: BookOpen },
    ] },
    { label: "Management", items: [
      { id: "members", label: "Members", icon: Users },
      { id: "reports", label: "Reports", icon: Inbox, badge: 1 },
      { id: "activity", label: "Activity", icon: Activity, badge: alerts.length },
    ] },
  ];
  return (
    <WorkspaceShell title="Control Room" subtitle="Owner workspace" context="Control room" groups={groups} active={sec} onSelect={(i) => setSec(i as Section)} altView={{ to: "/dashboard", label: "Member view" }} onRefresh={() => setChecked(new Date())}>
      {sec === "home" && <HomeView checked={checked} go={setSec} />}
      {sec === "whatsapp" && <WhatsAppHub />}
      {sec === "scribd" && <><PageHead eyebrow="Workspace" title="scribd" /><ScribdDesk /></>}
      {sec === "members" && <MembersView />}
      {sec === "reports" && <><PageHead eyebrow="Management" title="reports" /><SupportDesk owner /></>}
      {sec === "activity" && <ActivityView />}
    </WorkspaceShell>
  );
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "bad" }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertTriangle : XCircle;
  const c = { ok: "text-success", warn: "text-warning", bad: "text-destructive" }[tone];
  return (
    <div className="ink bg-card p-5">
      <div className="eyebrow">{label}</div>
      <div className={`mt-3 flex items-center gap-2 font-semibold ${c}`}><Icon size={18} />{value}</div>
    </div>
  );
}

function HomeView({ checked, go }: { checked: Date; go: (s: Section) => void }) {
  return (
    <>
      <PageHead eyebrow="Control room" title="overview" right={<span className="font-mono text-xs text-muted-foreground">checked {checked.toLocaleTimeString()}</span>} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatusCard label="Service bridge" value="Reachable" tone="ok" />
        <StatusCard label="WhatsApp" value="Connected" tone="ok" />
        <StatusCard label="Scribd" value="Checking" tone="warn" />
        <StatusCard label="Number list" value="Up to date" tone="ok" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="ink bg-card p-6">
          <div className="flex items-center justify-between"><h2 className="text-xl">needs attention</h2><Badge tone="warn">{alerts.length}</Badge></div>
          <ul className="mt-4 divide-y">
            {alerts.map((a) => (
              <li key={a.text}>
                <button onClick={() => go(a.go)} className="flex w-full items-center gap-3 py-3 text-left text-sm hover:underline">
                  {a.sev === "bad" ? <XCircle size={16} className="text-destructive" /> : <AlertTriangle size={16} className="text-warning" />}
                  {a.text}
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => go("activity")} className="mt-2 text-sm font-semibold underline underline-offset-4">All alerts</button>
        </div>
        <div className="ink bg-card p-6">
          <h2 className="text-xl">quick access</h2>
          <div className="mt-4 grid gap-3">
            {[
              { s: "whatsapp" as Section, t: "WhatsApp numbers", d: "3 numbers · 2 connected" },
              { s: "scribd" as Section, t: "Scribd library", d: "2 files · 1 in queue" },
              { s: "members" as Section, t: "Members", d: "14 allowed · 2 pending" },
            ].map((q) => (
              <button key={q.t} onClick={() => go(q.s)} className="border border-foreground p-4 text-left hover:bg-accent">
                <div className="font-semibold">{q.t}</div>
                <div className="font-mono text-xs text-muted-foreground">{q.d}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

const WA_TABS = ["Numbers", "Commands", "Status", "Power", "Sync", "Hosting"] as const;
type Num = { id: number; phone: string; label: string; state: "connected" | "paused" | "pairing" | "disconnected" };

function WhatsAppHub() {
  const [tab, setTab] = useState<(typeof WA_TABS)[number]>("Numbers");
  const [nums, setNums] = useState<Num[]>([
    { id: 1, phone: "+48 512 300 118", label: "Main", state: "connected" },
    { id: 2, phone: "+48 512 400 211", label: "Backup", state: "disconnected" },
    { id: 3, phone: "+44 7700 900 412", label: "UK", state: "connected" },
  ]);
  const [newPhone, setNewPhone] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [pairing, setPairing] = useState<number | null>(null);
  const [del, setDel] = useState<Num | null>(null);
  const [power, setPower] = useState<"restart" | "stop" | null>(null);
  const [svc, setSvc] = useState("Running");
  const [reveal, setReveal] = useState(false);
  const [cmds, setCmds] = useState({ "!sticker": true, "!dl": true, "!scribd": true, "!vault": false, "!ping": true });
  const tone = (s: Num["state"]) => (s === "connected" ? "ok" : s === "disconnected" ? "bad" : "warn");

  return (
    <>
      <PageHead eyebrow="Workspace" title="whatsapp" />
      <Tabs tabs={WA_TABS} value={tab} onChange={setTab} />

      {tab === "Numbers" && (
        <div className="space-y-6">
          {pairing && <PairingCodeBanner code="K4P9-2XQ7" onExpire={() => setPairing(null)} />}
          <form className="ink flex flex-col gap-3 bg-card p-5 sm:flex-row sm:items-end" onSubmit={(e) => {
            e.preventDefault();
            if (!newPhone.trim()) return;
            setNums([...nums, { id: Date.now(), phone: newPhone, label: newLabel || "Unlabeled", state: "pairing" }]);
            setNewPhone(""); setNewLabel("");
          }}>
            <label className="field flex-1"><input aria-label="Phone number" className="font-mono" placeholder="+48 …" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} /></label>
            <label className="field sm:w-40"><input aria-label="Label (optional)" placeholder="label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} /></label>
            <button className="btn"><Plus size={15} />Add number</button>
          </form>
          <div className="ink bg-card">
            {nums.length === 0 && <p className="p-6 text-sm text-muted-foreground">No numbers yet.</p>}
            <ul className="divide-y">
              {nums.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                    <div className="font-mono text-sm">{n.phone}</div>
                    <div className="text-xs text-muted-foreground">{n.label}</div>
                  </div>
                  <Badge tone={tone(n.state)}>{n.state}</Badge>
                  <button className="btn-ghost" onClick={() => setPairing(n.id)}>Pairing code</button>
                  <button className="btn-ghost" onClick={() => setNums(nums.map((x) => x.id === n.id ? { ...x, state: x.state === "paused" ? "connected" : "paused" } : x))}>{n.state === "paused" ? "Enable" : "Pause"}</button>
                  <button aria-label="Delete number" className="btn-ghost px-2 text-destructive" onClick={() => setDel(n)}><Trash2 size={15} /></button>
                </li>
              ))}
            </ul>
          </div>
          <Confirm open={!!del} title="delete number?" body={`${del?.phone} will be unlinked and removed.`} action="Delete" onClose={() => setDel(null)} onConfirm={() => setNums(nums.filter((x) => x.id !== del?.id))} />
        </div>
      )}

      {tab === "Commands" && (
        <div className="ink bg-card">
          <ul className="divide-y">
            {Object.entries(cmds).map(([c, on]) => (
              <li key={c} className="flex items-center justify-between px-5 py-3">
                <span className="font-mono text-sm">{c}</span>
                <button role="switch" aria-checked={on} aria-label={`Toggle ${c}`} onClick={() => setCmds({ ...cmds, [c]: !on })} className={`h-6 w-11 border-2 border-foreground p-0.5 ${on ? "bg-primary" : ""}`}>
                  <span className={`block h-full w-1/2 transition-transform ${on ? "translate-x-full bg-primary-foreground" : "bg-foreground"}`} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "Status" && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[["Uptime", "4d 11h"], ["RAM", "412 / 1024 MB"], ["Queue", "3 jobs"], ["Commands today", "1,284"], ["Downloads ok", "932"], ["Downloads failed", "17"], ["Heartbeat", "8s ago"], ["Version", "v2.14.1"]].map(([k, v]) => (
            <div key={k} className="ink bg-card p-5"><div className="eyebrow">{k}</div><div className="mt-2 font-mono text-lg">{v}</div></div>
          ))}
        </div>
      )}

      {tab === "Power" && (
        <div className="ink bg-card p-6">
          <div className="eyebrow">Service state</div>
          <div className="mt-2 flex items-center gap-2 font-semibold"><Power size={17} />{svc}</div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button className="btn" onClick={() => setSvc("Running")} disabled={svc === "Running"}>Start</button>
            <button className="btn-ghost" onClick={() => setPower("restart")}>Restart</button>
            <button className="btn-ghost text-destructive" onClick={() => setPower("stop")}>Stop</button>
          </div>
          <Confirm open={!!power} title={`${power} service?`} body="Every connected number will be briefly unavailable." action={power === "stop" ? "Stop" : "Restart"} onClose={() => setPower(null)} onConfirm={() => setSvc(power === "stop" ? "Stopped" : "Running (restarted)")} />
        </div>
      )}

      {tab === "Sync" && (
        <div className="ink space-y-5 bg-card p-6">
          <label className="block"><span className="eyebrow">Bot endpoint</span><span className="field"><input className="font-mono" defaultValue="https://bridge.zafar.app/v1" /></span></label>
          <label className="block"><span className="eyebrow">Bot token</span>
            <span className="field">
              <input className="font-mono" readOnly value={reveal ? "zf_live_9a71c3e0b2d84f61" : "••••••••••••••••••••"} />
              <button aria-label={reveal ? "Hide token" : "Reveal token"} onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </span>
          </label>
          <button className="btn">Save & verify</button>
        </div>
      )}

      {tab === "Hosting" && (
        <div className="ink bg-card p-6">
          <dl className="grid gap-4 sm:grid-cols-2">
            {[["Region", "eu-central"], ["Host", "bridge-01"], ["Connection", "Healthy"], ["Last deploy", "Nov 1, 2026"]].map(([k, v]) => (
              <div key={k}><dt className="eyebrow">{k}</dt><dd className="mt-1 font-mono">{v}</dd></div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

type Member = { id: number; name: string; email: string; role: "Root" | "Allowed" | "Blocked"; scribd: boolean };

function MembersView() {
  const [pending, setPending] = useState([
    { id: 11, name: "Amira K.", phone: "+48 600 111 222", ready: true },
    { id: 12, name: "Tomasz R.", phone: "+48 600 333 444", ready: false },
  ]);
  const [members, setMembers] = useState<Member[]>([
    { id: 1, name: "Priam Zafar", email: "owner@zafar.app", role: "Root", scribd: true },
    { id: 2, name: "Jonas P.", email: "jonas@mail.com", role: "Allowed", scribd: true },
    { id: 3, name: "Lena W.", email: "lena@mail.com", role: "Allowed", scribd: false },
    { id: 4, name: "Spam Bot", email: "x@spam.io", role: "Blocked", scribd: false },
  ]);
  const upd = (id: number, p: Partial<Member>) => setMembers(members.map((m) => (m.id === id ? { ...m, ...p } : m)));
  return (
    <>
      <PageHead eyebrow="Management" title="members" />
      <div className="ink mb-6 bg-card p-6">
        <h2 className="text-xl">link requests</h2>
        {pending.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No pending requests.</p> : (
          <ul className="mt-3 divide-y">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="w-full min-w-0 sm:w-auto sm:flex-1"><div className="text-sm font-semibold">{p.name}</div><div className="font-mono text-xs text-muted-foreground">{p.phone}</div></div>
                <Badge tone={p.ready ? "ok" : "warn"}>{p.ready ? "Link ready" : "Waiting"}</Badge>
                <button className="btn" disabled={!p.ready} onClick={() => setPending(pending.filter((x) => x.id !== p.id))}>Approve</button>
                <button className="btn-ghost" onClick={() => setPending(pending.filter((x) => x.id !== p.id))}>Reject</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ink bg-card">
        <ul className="divide-y">
          {members.map((m) => {
            const root = m.role === "Root";
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="w-full min-w-0 sm:w-auto sm:flex-1"><div className="text-sm font-semibold">{m.name}</div><div className="truncate font-mono text-xs text-muted-foreground">{m.email}</div></div>
                <Badge tone={m.role === "Blocked" ? "bad" : m.role === "Root" ? "neutral" : "ok"}>{m.role}</Badge>
                <button className="btn-ghost" disabled={root} onClick={() => upd(m.id, { scribd: !m.scribd })}>{m.scribd ? "Revoke" : "Grant Scribd"}</button>
                <button className="btn-ghost" disabled={root} onClick={() => upd(m.id, { role: m.role === "Blocked" ? "Allowed" : "Blocked" })}>{m.role === "Blocked" ? "Allow" : "Block"}</button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

const CATS = ["All", "Service", "Numbers", "Members", "Scribd"] as const;
function ActivityView() {
  const [tab, setTab] = useState<"Alerts" | "History">("Alerts");
  const [cat, setCat] = useState<(typeof CATS)[number]>("All");
  const history = [
    { t: "13:42", cat: "Service", text: "Service restarted by owner" },
    { t: "12:10", cat: "Members", text: "Jonas P. granted Scribd" },
    { t: "09:03", cat: "Numbers", text: "+44 7700 900 412 paired" },
    { t: "08:55", cat: "Scribd", text: "File ready: Linear Algebra Primer" },
  ];
  const list = tab === "Alerts" ? alerts.map((a) => ({ t: "now", cat: a.cat, text: a.text })) : history;
  return (
    <>
      <PageHead eyebrow="Management" title="activity" />
      <Tabs tabs={["Alerts", "History"] as const} value={tab} onChange={setTab} />
      <div className="mb-4 flex flex-wrap gap-2">
        {CATS.map((c) => <button key={c} onClick={() => setCat(c)} className={`border px-3 py-1 text-xs font-semibold ${cat === c ? "border-foreground bg-primary text-primary-foreground" : "border-foreground"}`}>{c}</button>)}
      </div>
      <div className="ink bg-card">
        <ul className="divide-y">
          {list.filter((x) => cat === "All" || x.cat === cat).map((x) => (
            <li key={x.text} className="flex gap-4 px-5 py-3 text-sm"><span className="w-12 font-mono text-muted-foreground">{x.t}</span><span className="flex-1">{x.text}</span><span className="eyebrow">{x.cat}</span></li>
          ))}
        </ul>
      </div>
    </>
  );
}
