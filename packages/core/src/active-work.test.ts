import { describe, expect, it } from 'vitest';
import {
  activeFilterOptions,
  DEFAULT_ACTIVE_FILTERS,
  filterActiveWork,
  groupByStatus,
  priorityRank,
  sortActiveWork,
  worstMRStatus,
  type ActiveFilters,
} from './active-work';
import { deriveMRStatus } from './mr-status';
import type { IssueDetail, MergeRequest, StatusCategory } from './types';
import type { IssueView, MRView } from './workspace';

const issue = (
  key: string,
  status: string,
  category: StatusCategory,
  over: Partial<IssueDetail> = {},
): IssueDetail => ({
  key,
  summary: `Summary of ${key}`,
  status,
  statusCategory: category,
  priority: 'Medium',
  rank: key,
  issueType: 'Story',
  url: '',
  inOpenSprint: true,
  updatedAt: '2026-01-10T00:00:00.000Z',
  completedAt: null,
  description: '',
  acceptanceCriteria: [],
  comments: [],
  ...over,
});

const mrView = (iid: number, over: Partial<MergeRequest> = {}): MRView => {
  const mr: MergeRequest = {
    ref: { projectId: '1', iid },
    projectPath: 'g/p',
    title: `MR ${iid}`,
    description: '',
    sourceBranch: `feature/branch-${iid}`,
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
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-10T00:00:00.000Z',
    mergedAt: null,
    ...over,
  };
  return {
    key: `1!${iid}`,
    mr,
    status: deriveMRStatus(mr),
    issueKeys: [],
    links: [],
    unlinkedKeys: [],
    isMine: true,
    isReviewer: false,
    needsMyReview: false,
  };
};

// Rank order: A-1 < A-2 < A-3 < A-4 < A-5
const views: IssueView[] = [
  { issue: issue('A-1', 'In Review', 'in_progress', { priority: 'Low' }), mrs: [mrView(1)] },
  {
    issue: issue('A-2', 'To Do', 'todo', { priority: 'Highest', inOpenSprint: false }),
    mrs: [],
  },
  {
    issue: issue('A-3', 'In Progress', 'in_progress', {
      priority: null,
      updatedAt: '2026-01-12T00:00:00.000Z',
    }),
    mrs: [mrView(3, { pipelineStatus: 'failed' }), mrView(4, { hasConflicts: true })],
  },
  {
    issue: issue('A-4', 'In Review', 'in_progress', { summary: 'Fix the login page' }),
    mrs: [mrView(5, { state: 'merged' })],
  },
  { issue: issue('A-5', 'To Do', 'todo', { priority: 'High' }), mrs: [] },
];

const keys = (vs: IssueView[]) => vs.map((v) => v.issue.key);
const f = (patch: Partial<ActiveFilters>): ActiveFilters => ({
  ...DEFAULT_ACTIVE_FILTERS,
  sprintOnly: false,
  ...patch,
});

describe('filterActiveWork', () => {
  it('limits to the current sprint', () => {
    expect(keys(filterActiveWork(views, f({ sprintOnly: true })))).toEqual([
      'A-1',
      'A-3',
      'A-4',
      'A-5',
    ]);
  });

  it('searches keys, summaries, MR titles and branches, case-insensitively', () => {
    expect(keys(filterActiveWork(views, f({ text: 'login' })))).toEqual(['A-4']);
    expect(keys(filterActiveWork(views, f({ text: 'a-2' })))).toEqual(['A-2']);
    expect(keys(filterActiveWork(views, f({ text: 'branch-4' })))).toEqual(['A-3']);
    expect(keys(filterActiveWork(views, f({ text: '!1' })))).toEqual(['A-1']);
  });

  it('filters by status and priority, with "None" for no priority', () => {
    expect(keys(filterActiveWork(views, f({ statuses: ['In Review'] })))).toEqual(['A-1', 'A-4']);
    expect(keys(filterActiveWork(views, f({ priorities: ['None'] })))).toEqual(['A-3']);
  });

  it('counts only open MRs for has/no MR', () => {
    expect(keys(filterActiveWork(views, f({ mr: 'has' })))).toEqual(['A-1', 'A-3']);
    // A-4's only MR is merged, so it has no open MR.
    expect(keys(filterActiveWork(views, f({ mr: 'none' })))).toEqual(['A-2', 'A-4', 'A-5']);
  });

  it('filters by the primary status of any open MR', () => {
    expect(keys(filterActiveWork(views, f({ mrStatus: 'merge_conflicts' })))).toEqual(['A-3']);
    expect(keys(filterActiveWork(views, f({ mrStatus: 'merged' })))).toEqual([]);
  });
});

describe('sortActiveWork', () => {
  it('sorts by rank by default and reverses on desc', () => {
    expect(keys(sortActiveWork(views, 'rank'))).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    expect(keys(sortActiveWork(views, 'rank', 'desc'))).toEqual([
      'A-5',
      'A-4',
      'A-3',
      'A-2',
      'A-1',
    ]);
  });

  it('sorts by priority with rank breaking ties and no priority last', () => {
    expect(keys(sortActiveWork(views, 'priority'))).toEqual(['A-2', 'A-5', 'A-4', 'A-1', 'A-3']);
  });

  it('sorts by status category, then name', () => {
    expect(keys(sortActiveWork(views, 'status'))).toEqual(['A-2', 'A-5', 'A-3', 'A-1', 'A-4']);
  });

  it('puts the most recently updated first', () => {
    expect(keys(sortActiveWork(views, 'updated'))[0]).toBe('A-3');
  });

  it('sorts keys numerically', () => {
    const many = [
      { issue: issue('A-10', 'To Do', 'todo'), mrs: [] },
      { issue: issue('A-9', 'To Do', 'todo'), mrs: [] },
    ];
    expect(keys(sortActiveWork(many, 'key'))).toEqual(['A-9', 'A-10']);
  });
});

describe('groupByStatus', () => {
  it('orders columns To Do → In Progress, then by first appearance in rank', () => {
    const groups = groupByStatus(sortActiveWork(views, 'rank'));
    expect(groups.map((g) => [g.status, keys(g.issues)])).toEqual([
      ['To Do', ['A-2', 'A-5']],
      ['In Review', ['A-1', 'A-4']],
      ['In Progress', ['A-3']],
    ]);
  });
});

describe('helpers', () => {
  it('ranks Jira priority names from both default schemes', () => {
    expect(priorityRank('Blocker')).toBeLessThan(priorityRank('Major'));
    expect(priorityRank('Highest')).toBeLessThan(priorityRank('Medium'));
    expect(priorityRank('Custom P2')).toBe(priorityRank('Medium'));
    expect(priorityRank(null)).toBeGreaterThan(priorityRank('Lowest'));
  });

  it('picks the most urgent open MR status for the collapsed row', () => {
    expect(worstMRStatus(views[2]!)).toBe('merge_conflicts');
    expect(worstMRStatus(views[3]!)).toBeNull();
  });

  it('builds filter options from the data present', () => {
    expect(activeFilterOptions(views)).toEqual({
      statuses: ['To Do', 'In Review', 'In Progress'],
      priorities: ['Highest', 'High', 'Medium', 'Low', 'None'],
      mrStatuses: ['merge_conflicts', 'pipeline_failed', 'awaiting_review'],
    });
  });
});
