'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { fetchCurrentSession } from '@/lib/client-session';

export default function RootRouterPage() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const session = await fetchCurrentSession();
      if (!session) {
        router.replace('/login');
      } else if (session.user.isAdmin) {
        router.replace('/admin');
      } else {
        router.replace('/dashboard');
      }
    })();
  }, [router]);

  return (
    <div className="bg-canvas flex min-h-screen items-center justify-center">
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-5 py-3.5 text-sm font-medium text-ink-soft shadow-sm">
        <Loader2 className="h-4 w-4 animate-spin text-accent-600" />
        Opening your workspace…
      </div>
    </div>
  );
}
