import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";

export function PairingCodeBanner({ code, seconds = 120, onExpire }: { code: string; seconds?: number; onExpire?: () => void }) {
  const [left, setLeft] = useState(seconds);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (left <= 0) { onExpire?.(); return; }
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="ink bg-card p-5">
      <div className="eyebrow">Pairing code</div>
      <div className="mt-2 flex flex-wrap items-center gap-4">
        <span className="font-mono text-3xl font-bold tracking-[0.3em]">{left > 0 ? code : "------"}</span>
        <button className="btn-ghost" onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}
        </button>
        <span className={`font-mono text-sm ${left < 20 ? "text-destructive" : "text-muted-foreground"}`}>{left > 0 ? `expires in ${mm}` : "expired"}</span>
      </div>
    </div>
  );
}
