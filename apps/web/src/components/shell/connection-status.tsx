import type { Connection, ConnectionState } from '@tab-enter/core';
import Link from 'next/link';
import { cn } from '@/lib/utils';

const DOT: Record<ConnectionState, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  demo: 'bg-info',
  off: 'bg-muted-foreground/40',
};

const STATE_LABEL: Record<ConnectionState, string> = {
  ok: 'connected',
  warning: 'needs attention',
  error: 'error',
  demo: 'demo',
  off: 'not connected',
};

export function ConnectionStatus({ connections }: { connections: Connection[] }) {
  return (
    <ul className="flex items-center gap-2.5" aria-label="Connections">
      {connections.map((c) => (
        <li key={c.id}>
          <Link
            href="/settings"
            title={`${c.label}: ${c.detail}`}
            className="flex items-center gap-1 rounded px-0.5 hover:text-foreground"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', DOT[c.state])} aria-hidden />
            {c.label}
            <span className="sr-only">: {STATE_LABEL[c.state]}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
