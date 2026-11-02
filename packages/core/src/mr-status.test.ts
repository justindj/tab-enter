import { describe, expect, it } from 'vitest';
import { deriveMRStatus } from './mr-status';

const base = {
  state: 'opened' as const,
  draft: false,
  hasConflicts: false,
  pipelineStatus: 'success' as const,
  changesRequested: false,
  unresolvedThreads: 0,
  approvedBy: [] as string[],
  approvalsRequired: 1,
};

describe('deriveMRStatus', () => {
  it('is awaiting review by default', () => {
    expect(deriveMRStatus(base)).toEqual({ primary: 'awaiting_review', secondary: [] });
  });

  it('ranks conflicts above everything, with the rest as secondary badges', () => {
    expect(
      deriveMRStatus({
        ...base,
        hasConflicts: true,
        pipelineStatus: 'failed',
        unresolvedThreads: 2,
      }),
    ).toEqual({
      primary: 'merge_conflicts',
      secondary: ['pipeline_failed', 'changes_requested', 'awaiting_review'],
    });
  });

  it('treats unresolved threads as changes requested', () => {
    expect(deriveMRStatus({ ...base, unresolvedThreads: 1 }).primary).toBe('changes_requested');
    expect(deriveMRStatus({ ...base, changesRequested: true }).primary).toBe('changes_requested');
  });

  it('is approved once required approvals are met', () => {
    expect(deriveMRStatus({ ...base, approvedBy: ['dana'] }).primary).toBe('approved');
    expect(deriveMRStatus({ ...base, approvedBy: ['dana'], approvalsRequired: 2 }).primary).toBe(
      'awaiting_review',
    );
  });

  it('needs at least one approval even when none are required', () => {
    expect(deriveMRStatus({ ...base, approvalsRequired: 0 }).primary).toBe('awaiting_review');
  });

  it('shows drafts as Draft rather than awaiting review', () => {
    expect(deriveMRStatus({ ...base, draft: true })).toEqual({ primary: 'draft', secondary: [] });
    expect(deriveMRStatus({ ...base, draft: true, pipelineStatus: 'failed' })).toEqual({
      primary: 'pipeline_failed',
      secondary: ['draft'],
    });
  });

  it('short-circuits merged and closed', () => {
    expect(deriveMRStatus({ ...base, state: 'merged', hasConflicts: true })).toEqual({
      primary: 'merged',
      secondary: [],
    });
    expect(deriveMRStatus({ ...base, state: 'closed' }).primary).toBe('closed');
  });
});
