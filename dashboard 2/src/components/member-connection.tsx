import { useEffect, useState } from "react";
import { Phone, User } from "lucide-react";
import { Fox, Bubble } from "./fox";
import { PairingCodeBanner } from "./pairing-code-banner";
import { useSession } from "@/lib/session";

export function MemberConnection() {
  const { session, update, signOut } = useSession();
  const [name, setName] = useState(session?.name ?? "");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [cool, setCool] = useState(0);

  useEffect(() => {
    if (cool <= 0) return;
    const t = setTimeout(() => setCool(cool - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);

  const request = () => {
    if (!name.trim()) return setErr("Enter your name.");
    if (!/^\+\d[\d\s]{7,}$/.test(phone.trim())) return setErr("Use international format, e.g. +48 512 300 118.");
    setErr("");
    setCode(Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase());
    setCool(45);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[480px]">
        <div className="flex items-center gap-4"><Fox size={72} className="shrink-0" /><Bubble>let's connect your WhatsApp so i can help.</Bubble></div>
        <form className="ink mt-6 bg-background p-6 sm:p-8" onSubmit={(e) => { e.preventDefault(); request(); }} noValidate>
          <h1 className="text-2xl">link your number</h1>
          <div className="mt-5 space-y-4">
            <label className="field"><User size={17} /><input aria-label="Your name" placeholder="your name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><Phone size={17} /><input aria-label="Phone number" className="font-mono" inputMode="tel" placeholder="+48 512 300 118" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          </div>
          {err && <p role="alert" className="mt-4 border-l-2 border-destructive pl-3 text-sm text-destructive">{err}</p>}
          <button className="btn mt-6 w-full" disabled={cool > 0}>{code ? (cool > 0 ? `Resend in ${cool}s` : "Get a new code") : "Get code"}</button>
        </form>
        {code && (
          <div className="mt-6 space-y-4">
            <PairingCodeBanner key={code} code={code} onExpire={() => setErr("Code expired. Request a new one.")} />
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Open WhatsApp on your phone.</li>
              <li>Go to <strong className="text-foreground">Linked devices → Link a device</strong>.</li>
              <li>Tap <strong className="text-foreground">Link with phone number</strong> and enter the code.</li>
            </ol>
            <button className="btn-ghost w-full" onClick={() => update({ name, phone, linked: true })}>I've entered the code</button>
          </div>
        )}
        <button className="mt-6 w-full text-center text-sm text-muted-foreground underline underline-offset-4" onClick={signOut}>Sign out</button>
      </div>
    </div>
  );
}
