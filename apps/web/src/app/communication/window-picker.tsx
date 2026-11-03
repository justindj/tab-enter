'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';

const MODES = [
  { value: '', label: 'Default (Settings)' },
  { value: 'last24h', label: 'Last 24 hours' },
  { value: 'sinceLastReport', label: 'Since my last report' },
  { value: 'customHours', label: 'Custom hours' },
  { value: 'sinceDate', label: 'Since a date/time' },
] as const;

/** Change the daily report window for this report only (via the URL). */
export function WindowPicker() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [mode, setMode] = useState(params.get('window') ?? '');
  const [hours, setHours] = useState(params.get('hours') ?? '8');
  const [since, setSince] = useState(params.get('since') ?? '');

  const apply = (next = mode) => {
    const q = new URLSearchParams();
    if (next) q.set('window', next);
    if (next === 'customHours') q.set('hours', hours);
    if (next === 'sinceDate' && since) q.set('since', since);
    router.replace(q.size ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <Select
        aria-label="Report window"
        value={mode}
        onChange={(e) => {
          setMode(e.target.value);
          if (!['customHours', 'sinceDate'].includes(e.target.value)) apply(e.target.value);
        }}
        className="w-auto"
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </Select>
      {mode === 'customHours' && (
        <Input
          aria-label="Hours"
          type="number"
          min={1}
          max={24 * 14}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="w-20"
        />
      )}
      {mode === 'sinceDate' && (
        <Input
          aria-label="Since"
          type="datetime-local"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="w-auto"
        />
      )}
      {(mode === 'customHours' || mode === 'sinceDate') && (
        <Button type="submit" size="sm" variant="outline">
          Apply
        </Button>
      )}
    </form>
  );
}
