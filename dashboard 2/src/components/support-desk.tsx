import { useState } from "react";
import { Send } from "lucide-react";
import { Badge } from "./workspace-shell";

type Msg = { from: "member" | "owner"; text: string };
type Ticket = { id: number; member: string; subject: string; unread: boolean; msgs: Msg[] };

const seed: Ticket[] = [
  { id: 1, member: "Amira K.", subject: "Pairing code expired", unread: true, msgs: [{ from: "member", text: "My code expired before I could type it in." }] },
  { id: 2, member: "Jonas P.", subject: "Scribd access", unread: false, msgs: [{ from: "member", text: "Could I get Scribd access?" }, { from: "owner", text: "Granted — try now." }] },
];

/** owner=true: inbox of all member tickets. owner=false: the member's own conversation. */
export function SupportDesk({ owner }: { owner: boolean }) {
  const [tickets, setTickets] = useState<Ticket[]>(owner ? seed : [{ id: 9, member: "you", subject: "My conversation", unread: false, msgs: [] }]);
  const [sel, setSel] = useState(tickets[0]?.id ?? 0);
  const [text, setText] = useState("");
  const t = tickets.find((x) => x.id === sel)!;

  const send = () => {
    if (!text.trim()) return;
    setTickets((ts) => ts.map((x) => (x.id === sel ? { ...x, msgs: [...x.msgs, { from: owner ? "owner" : "member", text }] } : x)));
    setText("");
  };

  return (
    <div className={`grid gap-6 ${owner ? "lg:grid-cols-[280px_1fr]" : ""}`}>
      {owner && (
        <ul className="ink bg-card">
          {tickets.map((x) => (
            <li key={x.id}>
              <button onClick={() => { setSel(x.id); setTickets((ts) => ts.map((y) => (y.id === x.id ? { ...y, unread: false } : y))); }} className={`w-full border-b px-4 py-3 text-left ${sel === x.id ? "bg-accent" : ""}`}>
                <div className="flex items-center justify-between gap-2 text-sm font-semibold">{x.member}{x.unread && <Badge tone="warn">New</Badge>}</div>
                <div className="text-xs text-muted-foreground">{x.subject}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ink flex min-h-[360px] flex-col bg-card p-6">
        <h2 className="text-xl">{owner ? t.subject : "talk to the owner"}</h2>
        <div className="mt-4 flex-1 space-y-3">
          {t.msgs.length === 0 && <p className="text-sm text-muted-foreground">No messages yet. Describe your problem below.</p>}
          {t.msgs.map((m, i) => {
            const mine = (m.from === "owner") === owner;
            return <div key={i} className={`max-w-[80%] px-3 py-2 text-sm ${mine ? "ml-auto bg-primary text-primary-foreground" : "border border-foreground"}`}>{m.text}</div>;
          })}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="mt-4 flex gap-3">
          <label className="field flex-1"><input aria-label="Message" placeholder="write a reply" value={text} onChange={(e) => setText(e.target.value)} /></label>
          <button className="btn" aria-label="Send"><Send size={15} /></button>
        </form>
      </div>
    </div>
  );
}
