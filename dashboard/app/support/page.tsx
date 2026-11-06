'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { fetchCurrentSession } from '@/lib/client-session';
import { SupportDesk } from '@/components/support-desk';

export default function SupportPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => { void fetchCurrentSession().then((session) => { if (!session) router.replace('/login'); else if (session.user.isAdmin) router.replace('/admin'); else setReady(true); }); }, [router]);
  return <main className="min-h-screen bg-paper px-4 py-6"><div className="mx-auto max-w-[500px]"><button type="button" onClick={() => router.push('/dashboard')} className="mb-4 inline-flex min-h-[44px] items-center gap-2 text-xs font-semibold text-accent"><ArrowLeft className="h-4 w-4"/> Back to connection</button>{ready && <SupportDesk/>}</div></main>;
}
