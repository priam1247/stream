import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Lock, Mail, User, KeyRound, ArrowLeft } from "lucide-react";
import { Fox, Bubble } from "./fox";
import { homeFor, useSession, type Session } from "@/lib/session";

type Mode = "signin" | "register" | "verify" | "forgot" | "reset";

export function AuthScreen() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cool, setCool] = useState(0);

  useEffect(() => {
    if (cool <= 0) return;
    const t = setTimeout(() => setCool(cool - 1), 1000);
    return () => clearTimeout(t);
  }, [cool]);

  const go = (m: Mode) => { setMode(m); setErr(""); setNotice(""); };
  const finish = (s: Session) => { signIn(s); navigate({ to: homeFor(s) }); };
  const fake = (fn: () => void) => { setBusy(true); setErr(""); setTimeout(() => { setBusy(false); fn(); }, 500); };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "signin") {
      if (!email.includes("@") || !pw) return setErr("Enter your email and password.");
      const owner = email.toLowerCase().startsWith("owner");
      fake(() => finish({ name: owner ? "Priam Zafar" : email.split("@")[0] ?? email, email, role: owner ? "owner" : "member", linked: false, scribd: false }));
    } else if (mode === "register") {
      if (!name.trim()) return setErr("Tell us your name.");
      if (!email.includes("@")) return setErr("Enter a valid email.");
      if (pw.length < 6) return setErr("Password must be at least 6 characters.");
      fake(() => { go("verify"); setCool(30); setNotice("Preview code: 123456"); });
    } else if (mode === "verify") {
      if (code.length !== 6) return setErr("Enter the 6-digit code.");
      fake(() => finish({ name, email, role: "member", linked: false, scribd: false }));
    } else if (mode === "forgot") {
      if (!email.includes("@")) return setErr("Enter a valid email.");
      fake(() => { go("reset"); setNotice("We sent a reset code to your email."); });
    } else {
      if (code.length !== 6 || pw.length < 6) return setErr("Enter the code and a 6+ character password.");
      fake(() => { go("signin"); setNotice("Password saved. Sign in with your new password."); });
    }
  };

  const titles: Record<Mode, string> = {
    signin: "welcome back", register: "make an account", verify: "check your email", forgot: "forgot password", reset: "new password",
  };
  const greet: Record<Mode, string> = {
    signin: "hey! sign in and i'll fetch your workspace.",
    register: "new here? it takes a minute.",
    verify: "i sent you a 6-digit code.",
    forgot: "happens to everyone.",
    reset: "pick something you'll remember.",
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center bg-primary text-lg font-bold text-primary-foreground">z</span>
          <div>
            <div className="text-lg font-bold leading-tight">zAfAr</div>
            <div className="text-sm text-muted-foreground">Your WhatsApp companion</div>
          </div>
        </div>

        <div className="mt-8 flex items-center gap-4">
          <Fox size={76} className="shrink-0" />
          <Bubble>{greet[mode]}</Bubble>
        </div>

        <form onSubmit={submit} noValidate className="ink mt-6 bg-background p-6 sm:p-8">
          {(mode === "signin" || mode === "register") && (
            <div className="seg mb-6 flex w-full">
              <button type="button" className="flex-1" aria-pressed={mode === "signin"} onClick={() => go("signin")}>Sign in</button>
              <button type="button" className="flex-1" aria-pressed={mode === "register"} onClick={() => go("register")}>Register</button>
            </div>
          )}
          {(mode === "verify" || mode === "forgot" || mode === "reset") && (
            <button type="button" onClick={() => go("signin")} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={14} />Back</button>
          )}
          <h1 className="text-2xl">{titles[mode]}</h1>

          <div className="mt-5 space-y-4">
            {mode === "register" && (
              <label className="field"><User size={17} aria-hidden /><input aria-label="Full name" placeholder="full name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            )}
            {(mode === "signin" || mode === "register" || mode === "forgot") && (
              <label className="field"><Mail size={17} aria-hidden /><input aria-label="Email" type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            )}
            {(mode === "verify" || mode === "reset") && (
              <label className="field"><KeyRound size={17} aria-hidden /><input aria-label="Verification code" inputMode="numeric" maxLength={6} placeholder="6-digit code" className="font-mono tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>
            )}
            {(mode === "signin" || mode === "register" || mode === "reset") && (
              <label className="field">
                <Lock size={17} aria-hidden />
                <input aria-label={mode === "reset" ? "New password" : "Password"} type={show ? "text" : "password"} placeholder={mode === "reset" ? "new password" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} />
                <button type="button" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)} className="text-muted-foreground">{show ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </label>
            )}
          </div>

          {mode === "signin" && (
            <div className="mt-3 text-right"><button type="button" onClick={() => go("forgot")} className="text-sm font-semibold underline underline-offset-4">Forgot?</button></div>
          )}

          {err && <p role="alert" className="mt-4 border-l-2 border-destructive pl-3 text-sm text-destructive">{err}</p>}
          {notice && <p className="mt-4 border-l-2 border-success pl-3 text-sm">{notice}</p>}

          <button type="submit" disabled={busy} className="btn mt-6 w-full">
            {busy ? "…" : { signin: "Sign in", register: "Create account", verify: "Verify & continue", forgot: "Send reset code", reset: "Save password" }[mode]}
          </button>

          {mode === "verify" && (
            <button type="button" disabled={cool > 0} onClick={() => { setCool(30); setNotice("New code sent. Preview code: 123456"); }} className="mt-3 w-full text-sm font-semibold disabled:text-muted-foreground">
              {cool > 0 ? <>Resend in <span className="font-mono">{cool}s</span></> : "Resend code"}
            </button>
          )}
        </form>
        <div className="mt-6">
          <div className="eyebrow text-center">or jump straight in</div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button type="button" className="btn-ghost" onClick={() => finish({ name: "Priam Zafar", email: "owner@zafar.app", role: "owner", linked: true, scribd: true })}>Owner</button>
            <button type="button" className="btn-ghost" onClick={() => finish({ name: "Amira Nowak", email: "amira@mail.com", role: "member", linked: false, scribd: false })}>New member</button>
            <button type="button" className="btn-ghost" onClick={() => finish({ name: "Jonas Pike", email: "jonas@mail.com", role: "member", linked: true, phone: "+48 600 111 222", scribd: true })}>Linked member</button>
          </div>
        </div>
      </div>
    </div>
  );
}
