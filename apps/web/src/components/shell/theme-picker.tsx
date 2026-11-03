'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTransition } from 'react';
import { changeTheme } from '@/app/actions';
import { cn } from '@/lib/utils';

type Theme = 'dark' | 'light' | 'system';

const OPTIONS: { value: Theme; label: string; Icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * Dark / Light / System segmented control. Applies at once on the page, then
 * saves the choice (app-wide) so the server renders it next time.
 */
export function ThemePicker({ theme, showLabels = false }: { theme: Theme; showLabels?: boolean }) {
  const [, startTransition] = useTransition();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md border p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = value === theme;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={`${label} theme`}
            onClick={() => {
              document.documentElement.dataset.theme = value;
              startTransition(() => changeTheme(value));
            }}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs',
              selected
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {showLabels ? label : <span className="sr-only">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
