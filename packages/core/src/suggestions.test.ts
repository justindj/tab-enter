import { describe, expect, it } from 'vitest';
import { errorFocusedTail, estimateTokens, stripAnsi, threadsBlock, truncate } from './context';
import { parseProfileSettings } from './settings';
import { buildSuggestions } from './suggestions';
import { renderTemplate } from './templates';
import type { IssueDetail, MergeRequest } from './types';
import { buildWorkspace } from './workspace';

const now = new Date('2026-01-15T17:00:00.000Z');

const issue = (key: string, over: Partial<IssueDetail> = {}): IssueDetail => ({
  key,
  summary: `Summary ${key}`,
  status: 'To Do',
  statusCategory: 'todo',
  priority: 'High',
  rank: key,
  issueType: 'Story',
  url: `https://jira.example.test/browse/${key}`,
  inOpenSprint: true,
  updatedAt: '2026-01-15T10:00:00.000Z',
  completedAt: null,
  description: 'Long description. '.repeat(50),
  acceptanceCriteria: ['It works'],
  comments: [{ author: 'Sam', body: 'Please hurry', createdAt: '2026-01-14T10:00:00.000Z' }],
  ...over,
});

const mr = (iid: number, over: Partial<MergeRequest> = {}): MergeRequest => ({
  ref: { projectId: '42', iid },
  projectPath: 'acme/shop',
  title: `MR ${iid}`,
  description: '',
  sourceBranch: `feature/A-${iid}`,
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  author: 'me',
  webUrl: `https://gitlab.example.test/acme/shop/-/merge_requests/${iid}`,
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
  createdAt: '2026-01-14T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
  mergedAt: null,
  ...over,
});

const settings = parseProfileSettings({
  gitlab: { projects: [{ id: '42', path: 'acme/shop', localPath: '/code/shop' }] },
  contextCaps: { descriptionChars: 200 },
});

function workspace() {
  const mine = (m: MergeRequest) => ({
    mr: m,
    isMine: true,
    isReviewer: false,
    needsMyReview: false,
  });
  return buildWorkspace({
    now,
    retentionDays: 3,
    issues: [
      issue('A-1', { status: 'In Progress', statusCategory: 'in_progress' }),
      issue('A-2'),
      issue('A-3', { inOpenSprint: false }),
      issue('A-4'),
      issue('A-5'),
      issue('A-6'),
      issue('A-7', { statusCategory: 'in_progress' }),
    ],
    mergeRequests: [
      mine(
        mr(1, {
          unresolvedThreads: 1,
          pipelineStatus: 'failed',
          threads: [{ author: 'riley', body: 'Rename this', filePath: 'src/a.ts', line: 3 }],
        }),
      ),
      mine(
        mr(2, {
          pipelineStatus: 'failed',
          pipelineFailures: [{ job: 'test', stage: 'test', logTail: 'ok\nError: boom\n' }],
        }),
      ),
      mine(mr(3, { hasConflicts: true })),
      mine(mr(4)), // nothing to do
      { mr: mr(9, { author: 'sam' }), isMine: false, isReviewer: true, needsMyReview: true },
    ],
    links: [
      { mrKey: '42!1', issueKey: 'A-1', source: 'branch' },
      { mrKey: '42!2', issueKey: 'A-2', source: 'branch' },
    ],
  });
}

describe('buildSuggestions', () => {
  const suggestions = buildSuggestions(workspace(), settings);

  it('ranks feedback, pipelines, conflicts, reviews, then next tickets', () => {
    expect(suggestions.map((s) => s.id)).toEqual([
      'address-feedback:42!1',
      'fix-pipeline:42!2',
      'resolve-conflicts:42!3',
      'review:42!9',
      'next-ticket:A-4',
      'next-ticket:A-5',
      'next-ticket:A-6',
    ]);
  });

  it('lists every reason but files the MR under the most urgent one', () => {
    expect(suggestions[0]).toMatchObject({
      reason: '1 unresolved thread · pipeline failed',
      issueKey: 'A-1',
      preset: 'address-feedback',
      projectId: '42',
    });
  });

  it('skips tickets out of sprint, in progress, or with an open MR', () => {
    const next = suggestions.filter((s) => s.kind === 'next-ticket').map((s) => s.issueKey);
    expect(next).not.toContain('A-2'); // has an open MR
    expect(next).not.toContain('A-3'); // not in sprint
    expect(next).not.toContain('A-7'); // in progress
  });

  it('fills prompts from compact context blocks', () => {
    const feedback = suggestions[0]!.prompt;
    expect(feedback).toContain('- riley (src/a.ts:3): Rename this');
    expect(feedback).toContain('- It works');
    const pipeline = suggestions[1]!.prompt;
    expect(pipeline).toContain('Job "test" (stage test) failed');
    expect(pipeline).toContain('Error: boom');
    const next = suggestions.find((s) => s.id === 'next-ticket:A-4')!.prompt;
    expect(next).toContain('A-4: Summary A-4');
    expect(next).toContain('- Sam: Please hurry');
    expect(next).toContain('[…]'); // description capped at 200 chars
    expect(next.length).toBeLessThan(1500);
  });

  it('uses the single watched project with a clone for new tickets', () => {
    expect(suggestions.find((s) => s.kind === 'next-ticket')!.projectId).toBe('42');
  });

  it('offers no Claude run for reviews until M5', () => {
    expect(suggestions.find((s) => s.kind === 'review')!.preset).toBeNull();
  });
});

describe('context builders', () => {
  it('renders templates and drops lines whose variables are empty', () => {
    expect(
      renderTemplate('A {{x.y}}\n{{ticket.comments}}\nB', { 'ticket.key': 'K' } as never),
    ).toBe('A \nB');
  });

  it('truncates on a boundary and marks it', () => {
    expect(truncate('one two three four', 12)).toBe('one two […]');
    expect(truncate('short', 12)).toBe('short');
  });

  it('keeps the error and the tail of a long CI log', () => {
    const log = [
      ...Array.from({ length: 50 }, (_, i) => `setup ${i}`),
      '\u001b[31mError: expected 2 to equal 3\u001b[0m',
      ...Array.from({ length: 30 }, (_, i) => `after ${i}`),
    ].join('\n');
    const tail = errorFocusedTail(log, 20);
    expect(tail).toContain('Error: expected 2 to equal 3');
    expect(tail).toContain('after 29');
    expect(tail).not.toContain('setup 10');
    expect(tail.split('\n').length).toBeLessThanOrEqual(21);
    expect(stripAnsi('\u001b[1mbold\u001b[0m')).toBe('bold');
  });

  it('points at the MR when thread text was not synced', () => {
    expect(threadsBlock(mr(1, { unresolvedThreads: 2 }))).toMatch(/2 unresolved/);
  });

  it('estimates tokens', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});
