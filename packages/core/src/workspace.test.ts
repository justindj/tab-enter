import { describe, expect, it } from 'vitest';
import type { IssueDetail, MergeRequest } from './types';
import { buildWorkspace } from './workspace';

const now = new Date('2026-01-15T17:00:00.000Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const issue = (key: string, over: Partial<IssueDetail> = {}): IssueDetail => ({
  key,
  summary: key,
  status: 'In Progress',
  statusCategory: 'in_progress',
  priority: null,
  rank: key,
  issueType: 'Task',
  url: '',
  inOpenSprint: true,
  updatedAt: hoursAgo(1),
  completedAt: null,
  description: '',
  acceptanceCriteria: [],
  comments: [],
  ...over,
});

const mr = (iid: number, over: Partial<MergeRequest> = {}): MergeRequest => ({
  ref: { projectId: '1', iid },
  projectPath: 'g/p',
  title: '',
  description: '',
  sourceBranch: '',
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  author: 'me',
  webUrl: '',
  detailedMergeStatus: '',
  hasConflicts: false,
  pipelineStatus: 'success',
  approvedBy: [],
  approvalsRequired: 1,
  unresolvedThreads: 0,
  changesRequested: false,
  reviewers: [],
  linesAdded: 0,
  linesRemoved: 0,
  headSha: '',
  createdAt: hoursAgo(10),
  updatedAt: hoursAgo(1),
  mergedAt: null,
  ...over,
});

const mine = (m: MergeRequest) => ({
  mr: m,
  isMine: true,
  isReviewer: false,
  needsMyReview: false,
});

describe('buildWorkspace', () => {
  const ws = buildWorkspace({
    now,
    retentionDays: 3,
    issues: [
      issue('A-2'),
      issue('A-1'),
      issue('A-3', { statusCategory: 'done', completedAt: hoursAgo(5) }),
      issue('A-4', { statusCategory: 'done', completedAt: hoursAgo(24 * 5) }),
    ],
    mergeRequests: [
      mine(mr(1, { pipelineStatus: 'failed' })),
      mine(mr(2)),
      mine(mr(3, { state: 'merged', mergedAt: hoursAgo(2) })),
      {
        mr: mr(8, { author: 'sam', createdAt: hoursAgo(50) }),
        isMine: false,
        isReviewer: true,
        needsMyReview: false,
      },
      {
        mr: mr(9, { author: 'dana', createdAt: hoursAgo(20) }),
        isMine: false,
        isReviewer: true,
        needsMyReview: true,
      },
    ],
    links: [
      { mrKey: '1!1', issueKey: 'A-1', source: 'branch' },
      { mrKey: '1!3', issueKey: 'A-3', source: 'title' },
    ],
  });

  it('lists my open MRs with derived status and linked tickets', () => {
    expect(ws.inFlight.map((v) => [v.key, v.status.primary, v.issueKeys])).toEqual([
      ['1!1', 'pipeline_failed', ['A-1']],
      ['1!2', 'awaiting_review', []],
    ]);
  });

  it('flags unlinked MRs', () => {
    expect(ws.unlinkedMRs.map((v) => v.key)).toEqual(['1!2']);
  });

  it('orders active issues by rank with their MRs', () => {
    expect(ws.activeIssues.map((v) => [v.issue.key, v.mrs.map((m) => m.key)])).toEqual([
      ['A-1', ['1!1']],
      ['A-2', []],
    ]);
  });

  it('keeps recently completed work within the retention window', () => {
    expect(ws.recentlyCompleted.issues.map((i) => i.key)).toEqual(['A-3']);
    expect(ws.recentlyCompleted.mrs.map((v) => v.key)).toEqual(['1!3']);
  });

  it('puts reviews awaiting me first', () => {
    expect(ws.reviews.map((v) => v.key)).toEqual(['1!9', '1!8']);
  });
});
