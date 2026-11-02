'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav';

export function Sidebar({ counts }: { counts: Record<'now' | 'active' | 'review', number> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex w-52 shrink-0 flex-col border-r bg-card">
      <div className="px-4 py-4 font-mono text-sm font-semibold tracking-tight">
        tab<span className="text-primary">↹</span>enter
      </div>
      <ul className="flex-1 space-y-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const count = item.countKey ? counts[item.countKey] : undefined;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center justify-between rounded-md px-2 py-1.5 text-sm',
                  active
                    ? 'bg-accent font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <span>{item.label}</span>
                {count !== undefined && count > 0 && (
                  <span className="rounded bg-muted px-1.5 text-xs tabular-nums">{count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="px-4 py-3 text-xs text-muted-foreground">
        <kbd className="font-mono">g</kbd> + letter to navigate · <kbd className="font-mono">r</kbd>{' '}
        refresh
      </p>
    </nav>
  );
}
