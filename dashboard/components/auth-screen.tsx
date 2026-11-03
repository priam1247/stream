'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  User as UserIcon,
} from 'lucide-react';
import { AuthUser } from '@/lib/types';
import { ZafarFox } from './zafar-fox';

type AuthStep = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

interface AuthScreenProps {
  onAuthenticated: (payload: { token: string; user: AuthUser }) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [step, setStep] = useState<AuthStep>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [devCodeHint, setDevCodeHint] = useState<string | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let fullHeight = viewport.height;
    const update = () => {
      const focus = document.activeElement;
      const editing = focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement;
      if (!editing) fullHeight = Math.max(fullHeight, viewport.height);
      setKeyboardOpen(editing && viewport.height < fullHeight * 0.78);
    };
    viewport.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => { viewport.removeEventListener('resize', update); document.removeEventListener('focusin', update); document.removeEventListener('focusout', update); };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const switchStep = (next: AuthStep) => {
    setStep(next);
    setError(null);
    setInfo(null);
    setDevCodeHint(null);
    setCode('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.needsVerification) {
          setStep('verify');
          setInfo('Enter the 6-digit verification code sent to your email.');
          return;
        }
        throw new Error(data?.error || 'Sign in failed.');
      }
      onAuthenticated({ token: data.token, user: data.user });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);
    setDevCodeHint(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Registration failed.');
      if (data.requiresVerification === false) {
        setStep('login');
        setInfo(data.message || 'Account created. Please sign in.');
        return;
      }
      setStep('verify');
      setCooldown(45);
      setInfo(data.message || `Code sent to ${email.trim()}.`);
      if (data.devPreviewCode) setDevCodeHint(String(data.devPreviewCode));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          password: password || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Verification failed.');
      if (data.token && data.user) {
        onAuthenticated({ token: data.token, user: data.user });
        return;
      }
      setStep('login');
      setDevCodeHint(null);
      setInfo('Verified. Sign in below.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not resend code.');
      setCooldown(45);
      setInfo('Code resent.');
      if (data.devPreviewCode) setDevCodeHint(String(data.devPreviewCode));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend code.');
    } finally {
      setResending(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setDevCodeHint(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Request failed.');
      setStep('reset');
      setInfo('Reset code sent.');
      if (data.devPreviewCode) setDevCodeHint(String(data.devPreviewCode));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send reset code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Reset failed.');
      setPassword('');
      setNewPassword('');
      setCode('');
      setDevCodeHint(null);
      setStep('login');
      setInfo('Password updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-portal-canvas flex min-h-screen w-full flex-col justify-center overflow-x-hidden px-3.5 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-[440px]">
        <div className="mb-4 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-black text-sm font-black text-white">z</div>
          <div>
            <div className="text-[15px] font-extrabold tracking-tight text-slate-900">zAfAr</div>
            <div className="text-[11px] text-slate-500">Your WhatsApp companion</div>
          </div>
        </div>
        <div className="mb-4 flex items-center gap-2.5">
          <ZafarFox compact={keyboardOpen} />
          <div aria-live="polite" className="ink relative rounded-lg px-4 py-3 text-xs leading-relaxed text-slate-700">
            {step === 'register'
              ? 'Let’s get started! Create your account to link your number with the zAfAr WhatsApp bot.'
              : 'Hi, welcome to zAfAr! Sign in or create an account to link your number with the zAfAr WhatsApp bot.'}
          </div>
        </div>

        <div className="ink rounded-lg p-5 sm:p-6">
          {(step === 'login' || step === 'register') && (
            <div className="seg mb-5 flex w-full" role="group" aria-label="Account access">
              <button type="button" className="min-h-[44px] flex-1" aria-pressed={step === 'login'} onClick={() => switchStep('login')}>Sign in</button>
              <button type="button" className="min-h-[44px] flex-1" aria-pressed={step === 'register'} onClick={() => switchStep('register')}>Register</button>
            </div>
          )}

          {(step === 'verify' || step === 'forgot' || step === 'reset') && (
            <button
              type="button"
              onClick={() => switchStep('login')}
              className="mb-4 inline-flex min-h-[44px] items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
          )}

          <h1 className="mb-4 text-lg font-bold tracking-tight text-slate-900">
            {step === 'login' && 'Sign in'}
            {step === 'register' && 'Create account'}
            {step === 'verify' && 'Verify email'}
            {step === 'forgot' && 'Reset password'}
            {step === 'reset' && 'New password'}
          </h1>

          {error && (
            <div className="mb-3.5 break-words rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              {error}
            </div>
          )}

          {info && (
            <div className="mb-3.5 flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-medium text-teal-800">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600" />
              <span className="min-w-0 break-words">{info}</span>
            </div>
          )}

          {devCodeHint && (
            <div className="mb-3.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="font-semibold">Preview Code</div>
              <button
                type="button"
                onClick={() => setCode(devCodeHint)}
                className="mt-1.5 inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-1 font-mono text-sm font-bold tracking-[0.2em] text-teal-700 shadow-sm"
              >
                {devCodeHint}
              </button>
            </div>
          )}

          {step === 'login' && (
            <form onSubmit={handleLogin} className="space-y-3.5">
              <div>
                <label
                  htmlFor="login-email"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Email
                </label>
                <div className="relative ink-field">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="login-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label
                    htmlFor="login-password"
                    className="text-xs font-medium text-slate-700"
                  >
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => switchStep('forgot')}
                    className="min-h-[44px] text-xs font-semibold text-teal-700 hover:underline"
                  >
                    Forgot?
                  </button>
                </div>
                <div className="relative ink-field">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-11 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}

          {step === 'register' && (
            <form onSubmit={handleRegister} className="space-y-3.5">
              <div>
                <label
                  htmlFor="reg-name"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Name
                </label>
                <div className="relative ink-field">
                  <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="reg-name"
                    type="text"
                    required
                    maxLength={100}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="reg-email"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Email
                </label>
                <div className="relative ink-field">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="reg-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="reg-password"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Password
                </label>
                <div className="relative ink-field">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="reg-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-11 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Sending…' : 'Create account'}
              </button>
            </form>
          )}

          {step === 'verify' && (
            <form onSubmit={handleVerify} className="space-y-3.5">
              <div>
                <label
                  htmlFor="verify-code"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  6-digit code
                </label>
                <div className="relative ink-field">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-teal-600" />
                  <input
                    id="verify-code"
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    autoFocus
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    placeholder="000000"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 font-mono text-lg font-bold tracking-[0.25em] text-slate-900 placeholder:text-slate-300 focus:border-teal-600 focus:bg-white focus:outline-none tabular-nums"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Verifying…' : 'Verify'}
              </button>

              <div className="flex items-center justify-between pt-1 text-xs text-slate-500">
                <span>No code?</span>
                <button
                  type="button"
                  disabled={cooldown > 0 || resending}
                  onClick={handleResend}
                  className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-teal-700 hover:underline disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${resending ? 'animate-spin' : ''}`}
                  />
                  {cooldown > 0 ? `${cooldown}s` : 'Resend'}
                </button>
              </div>
            </form>
          )}

          {step === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-3.5">
              <div>
                <label
                  htmlFor="forgot-email"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Email
                </label>
                <div className="relative ink-field">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Sending…' : 'Send code'}
              </button>
            </form>
          )}

          {step === 'reset' && (
            <form onSubmit={handleReset} className="space-y-3.5">
              <div>
                <label
                  htmlFor="reset-code"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  6-digit code
                </label>
                <input
                  id="reset-code"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  placeholder="000000"
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 font-mono text-lg font-bold tracking-[0.25em] text-slate-900 placeholder:text-slate-300 focus:border-teal-600 focus:bg-white focus:outline-none tabular-nums"
                />
              </div>

              <div>
                <label
                  htmlFor="reset-new-pw"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  New password
                </label>
                <input
                  id="reset-new-pw"
                  autoComplete="new-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
