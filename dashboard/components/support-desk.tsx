'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, MessageSquare, Send } from 'lucide-react';
import { authHeaders } from '@/lib/client-session';
import type { SupportMessage, SupportThread } from '@/lib/storage';

export function SupportDesk({ admin = false, onUnreadChange }: { admin?: boolean; onUnreadChange?: (count: number) => void }) {
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const thread = selected;
    try {
      const url = admin && selected ? `/api/support?thread=${encodeURIComponent(selected)}` : '/api/support';
      const response = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Could not load messages.');
      // A slower earlier request must never show another member's messages
      // after the administrator has moved to a different conversation.
      if (request !== requestRef.current || selectedRef.current !== thread) return;
      if (Array.isArray(json.threads)) setThreads(json.threads);
      if (typeof json.unread === 'number') onUnreadChange?.(json.unread);
      if (Array.isArray(json.messages)) setMessages(json.messages);
      setError('');
    } catch (err) { if (request === requestRef.current && selectedRef.current === thread) setError(err instanceof Error ? err.message : 'Could not load messages.'); }
  }, [admin, selected, onUnreadChange]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 8000); return () => { window.clearInterval(timer); requestRef.current++; }; }, [load]);
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); if (!text.trim()) return;
    setBusy(true);
    const thread = selected;
    try {
      const response = await fetch('/api/support', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ text, ...(admin ? { thread: selected } : {}) }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Could not send your message.');
      if (selectedRef.current === thread) { setText(''); await load(); }
    } catch (err) { if (selectedRef.current === thread) setError(err instanceof Error ? err.message : 'Could not send your message.'); }
    finally { setBusy(false); }
  };
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" aria-label={admin ? 'Member reports' : 'Report a problem'}>
    <div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-teal-700"/><h1 className="text-base font-bold text-slate-900">{admin ? 'Member reports' : 'Report a problem'}</h1></div>
    <p className="mt-1 text-xs leading-5 text-slate-500">{admin ? 'Read and reply to members privately.' : 'Send a private message to the administrator. Do not include passwords or linking codes.'}</p>
    {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-800">{error}</p>}
    {admin && !selected ? <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">{threads.map((thread) => <button key={thread.email} type="button" onClick={() => { setMessages([]); setText(''); setError(''); setSelected(thread.email); }} className="flex min-h-[64px] w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50"><span className="min-w-0"><span className="block truncate text-xs font-bold text-slate-800">{thread.email}</span><span className="mt-1 block truncate text-[11px] text-slate-500">{thread.preview}</span></span>{thread.unread > 0 && <span className="rounded-full bg-rose-50 px-2 py-1 text-[10px] font-bold text-rose-700">{thread.unread} new</span>}</button>)}{!threads.length && <p className="p-5 text-center text-xs text-slate-500">No reports yet.</p>}</div> : <>
      {admin && <button type="button" onClick={() => { setSelected(''); setMessages([]); setText(''); setError(''); }} className="mt-4 flex min-h-[40px] items-center gap-1 text-xs font-semibold text-teal-700"><ArrowLeft className="h-3.5 w-3.5"/> All reports</button>}
      {admin && <p className="break-all text-xs font-semibold text-slate-700">{selected}</p>}
      <div aria-label="Conversation" className="mt-3 max-h-[420px] min-h-[120px] space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-3">{messages.map((message) => <div key={message.id} className={`max-w-[90%] rounded-xl px-3 py-2 ${message.role === (admin ? 'admin' : 'member') ? 'ml-auto bg-teal-100 text-teal-950' : 'bg-white text-slate-800'}`}><p className="whitespace-pre-wrap break-words text-xs leading-5">{message.text}</p><p className="mt-1 text-[10px] text-slate-500">{new Date(message.createdAt).toLocaleString()}</p></div>)}{!messages.length && <p className="py-6 text-center text-xs text-slate-500">No messages yet.</p>}</div>
      <form onSubmit={send} className="mt-3 space-y-2"><label htmlFor="support-message" className="sr-only">Your message</label><textarea id="support-message" maxLength={2000} required value={text} onChange={(event) => setText(event.target.value)} rows={3} placeholder="Describe the problem" className="w-full resize-y rounded-xl border border-slate-200 p-3 text-base outline-none focus:border-teal-600"/><div className="flex items-center justify-between"><span className="text-[10px] text-slate-400">{text.length}/2000</span><button disabled={busy || !text.trim()} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-teal-700 px-4 text-xs font-bold text-white disabled:opacity-50"><Send className="h-3.5 w-3.5"/> {busy ? 'Sending…' : 'Send message'}</button></div></form>
    </>}
  </section>;
}
