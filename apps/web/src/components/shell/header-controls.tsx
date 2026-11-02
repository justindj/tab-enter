'use client';

import { RefreshCw } from 'lucide-react';
import { useTransition } from 'react';
import { requestSync, switchProfile } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';

export function ProfileSwitcher({
  profiles,
  activeId,
}: {
  profiles: { id: string; name: string; isDemo: boolean }[];
  activeId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Select
      aria-label="Active profile"
      className="w-48"
      value={activeId}
      disabled={pending}
      onChange={(e) => {
        const id = e.target.value;
        startTransition(() => switchProfile(id));
      }}
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.isDemo ? ' (demo data)' : ''}
        </option>
      ))}
    </Select>
  );
}

export function RefreshButton({ syncing }: { syncing: boolean }) {
  const [pending, startTransition] = useTransition();
  const busy = pending || syncing;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => startTransition(() => requestSync())}
      disabled={busy}
      title="Sync now (r)"
    >
      <RefreshCw className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
      {busy ? 'Syncing' : 'Refresh'}
    </Button>
  );
}
