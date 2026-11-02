import type { MergeRequest } from './types';

export type MRStatus =
  | 'merge_conflicts'
  | 'pipeline_failed'
  | 'changes_requested'
  | 'awaiting_review'
  | 'approved'
  | 'draft'
  | 'merged'
  | 'closed';

export const MR_STATUS_LABELS: Record<MRStatus, string> = {
  merge_conflicts: 'Merge conflicts',
  pipeline_failed: 'Pipeline failed',
  changes_requested: 'Changes requested',
  awaiting_review: 'Awaiting review',
  approved: 'Approved, ready to merge',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

export interface DerivedMRStatus {
  primary: MRStatus;
  /** Every other status that also applies, in priority order. */
  secondary: MRStatus[];
}

type MRStatusInput = Pick<
  MergeRequest,
  | 'state'
  | 'draft'
  | 'hasConflicts'
  | 'pipelineStatus'
  | 'changesRequested'
  | 'unresolvedThreads'
  | 'approvedBy'
  | 'approvalsRequired'
>;

/**
 * One primary status per MR, by priority:
 * conflicts → pipeline failed → changes requested / unresolved threads →
 * awaiting review → approved → draft → merged.
 *
 * Merged and closed MRs are terminal and short-circuit everything else.
 * Drafts are never "awaiting review" or "approved": once the blocking checks
 * pass, a draft shows as Draft.
 */
export function deriveMRStatus(mr: MRStatusInput): DerivedMRStatus {
  if (mr.state === 'merged') return { primary: 'merged', secondary: [] };
  if (mr.state === 'closed') return { primary: 'closed', secondary: [] };

  const applies: MRStatus[] = [];
  if (mr.hasConflicts) applies.push('merge_conflicts');
  if (mr.pipelineStatus === 'failed') applies.push('pipeline_failed');
  if (mr.changesRequested || mr.unresolvedThreads > 0) applies.push('changes_requested');

  const approved = mr.approvedBy.length >= Math.max(1, mr.approvalsRequired);
  if (mr.draft) {
    applies.push('draft');
  } else if (approved) {
    applies.push('approved');
  } else {
    applies.push('awaiting_review');
  }

  const order: MRStatus[] = [
    'merge_conflicts',
    'pipeline_failed',
    'changes_requested',
    'awaiting_review',
    'approved',
    'draft',
  ];
  applies.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const [primary, ...secondary] = applies as [MRStatus, ...MRStatus[]];
  return { primary, secondary };
}

export type StatusTone = 'danger' | 'warning' | 'info' | 'success' | 'muted';

export const MR_STATUS_TONE: Record<MRStatus, StatusTone> = {
  merge_conflicts: 'danger',
  pipeline_failed: 'danger',
  changes_requested: 'warning',
  awaiting_review: 'info',
  approved: 'success',
  draft: 'muted',
  merged: 'success',
  closed: 'muted',
};
