import type { VerificationStatus } from '@tab-enter/db';

export const STATUS: Record<
  VerificationStatus,
  { label: string; tone: 'muted' | 'info' | 'success' | 'warning' | 'danger' }
> = {
  not_run: { label: 'Not run', tone: 'muted' },
  running: { label: 'Running', tone: 'info' },
  passed: { label: 'Passed', tone: 'success' },
  issues_found: { label: 'Issues found', tone: 'danger' },
  needs_coverage: { label: 'Needs coverage', tone: 'warning' },
  failed: { label: 'Could not run', tone: 'danger' },
};
