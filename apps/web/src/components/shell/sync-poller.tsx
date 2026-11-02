'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** While the worker is syncing, re-render every 2s so results appear without a manual reload. */
export function SyncPoller({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
