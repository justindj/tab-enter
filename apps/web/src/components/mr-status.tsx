import {
  MR_STATUS_LABELS,
  MR_STATUS_TONE,
  type DerivedMRStatus,
  type PipelineStatus,
} from '@tab-enter/core';
import { Badge } from '@/components/ui/badge';

export function MRStatusBadges({ status }: { status: DerivedMRStatus }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone={MR_STATUS_TONE[status.primary]}>{MR_STATUS_LABELS[status.primary]}</Badge>
      {status.secondary.map((s) => (
        <Badge key={s} tone="muted" title="Also applies">
          {MR_STATUS_LABELS[s]}
        </Badge>
      ))}
    </span>
  );
}

const PIPELINE_TONE: Record<PipelineStatus, 'danger' | 'warning' | 'info' | 'success' | 'muted'> = {
  success: 'success',
  failed: 'danger',
  running: 'info',
  pending: 'info',
  canceled: 'muted',
  skipped: 'muted',
  manual: 'warning',
  none: 'muted',
};

export function PipelineBadge({ status }: { status: PipelineStatus }) {
  return <Badge tone={PIPELINE_TONE[status]}>{status === 'none' ? 'no pipeline' : status}</Badge>;
}
