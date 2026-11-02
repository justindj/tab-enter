import type { ReactNode } from 'react';

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

export function ComingSoon({ milestone, children }: { milestone: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-10 text-center">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Arrives in {milestone}
      </p>
      <div className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
