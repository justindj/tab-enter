import type { ComponentProps, InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const control =
  'h-8 w-full rounded-md border bg-background px-2 text-sm placeholder:text-muted-foreground disabled:opacity-50';

// ComponentProps includes `ref` (React 19 passes it as a prop).
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(control, 'pr-6', className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Checkbox({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--primary)]" {...props} />
      <span>
        <span className="text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}
