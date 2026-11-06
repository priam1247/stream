'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { AuthScreen } from '@/components/auth-screen';
import {
  fetchCurrentSession,
  setSavedSessionToken,
} from '@/lib/client-session';

export default function LoginPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const session = await fetchCurrentSession();
      if (session) {
        router.replace(session.user.isAdmin ? '/admin' : '/dashboard');
        return;
      }
      setChecking(false);
    })();
  }, [router]);

  if (checking) {
    return (
      <div className="bg-paper flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-paper px-5 py-3.5 text-sm font-medium text-ink/80 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          Checking session…
        </div>
      </div>
    );
  }

  return (
    <AuthScreen
      onAuthenticated={({ token, user }) => {
        setSavedSessionToken(token);
        router.replace(user.isAdmin ? '/admin' : '/dashboard');
      }}
    />
  );
}
