import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        danger: 'bg-danger/15 text-danger',
        warning: 'bg-warning/15 text-warning',
        info: 'bg-info/15 text-info',
        success: 'bg-success/15 text-success',
        muted: 'bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'muted' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
