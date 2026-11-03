import { describe, expect, it } from 'vitest';
import {
  buildDailyReport,
  buildReviewRequest,
  cleanPolishResult,
  DEFAULT_MESSAGE_TEMPLATES,
  extractPolishMessage,
  polishPrompt,
  renderDailyReport,
  renderItem,
  renderMessage,
  renderReviewRequest,
} from './messages';
import { parseProfileSettings } from './settings';
import { buildSuggestions } from './suggestions';
import { dailyReportWindow } from './time-windows';
import type { IssueDetail, MergeRequest } from './types';
import { buildWorkspace } from './workspace';

// Local-time dates, since windows use the machine's local days.
const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h, 0, 0);
const wednesday = at(2026, 1, 14, 10);
const monday = at(2026, 1, 12, 10);

describe('dailyReportWindow', () => {
  const base = parseProfileSettings({}).timeWindows.dailyReport;

  it('covers the last 24 hours, or since Friday on a Monday', () => {
    expect(dailyReportWindow(base, wednesday, null).start).toEqual(at(2026, 1, 13, 10));
    const mon = dailyReportWindow(base, monday, null);
    expect(mon.start).toEqual(at(2026, 1, 9, 10)); // Friday, same time
    expect(mon.label).toMatch(/Friday 10:00 \(covers the weekend\)/);
    expect(dailyReportWindow({ ...base, mondayCoversWeekend: false }, monday, null).start).toEqual(
      at(2026, 1, 11, 10),
    );
  });

  it('starts at the last copied report, falling back to 24 hours', () => {
    const last = at(2026, 1, 13, 16);
    const w = dailyReportWindow({ ...base, mode: 'sinceLastReport' }, wednesday, last);
    expect(w.start).toEqual(last);
    expect(w.label).toBe('since your last report (Tuesday 16:00)');
    expect(dailyReportWindow({ ...base, mode: 'sinceLastReport' }, wednesday, null).label).toMatch(
      /no earlier report/,
    );
  });

  it('supports a chosen date and custom hours', () => {
    const since = at(2026, 1, 1, 9);
    expect(
      dailyReportWindow(
        { ...base, mode: 'sinceDate', sinceDate: since.toISOString() },
        wednesday,
        null,
      ).label,
    ).toBe('since 2026-01-01 09:00');
    expect(
      dailyReportWindow({ ...base, mode: 'customHours', customHours: 6 }, wednesday, null).start,
    ).toEqual(at(2026, 1, 14, 4));
  });
});

describe('polish', () => {
  it('wraps the message and cleans fenced or tagged answers', () => {
    const prompt = polishPrompt('*Done*\n• A-1', 'concise', 'slack');
    expect(extractPolishMessage(prompt)).toBe('*Done*\n• A-1');
    expect(prompt).toContain('Keep every ticket key');
    expect(cleanPolishResult('```\n*Done*\n• A-1\n```')).toBe('*Done*\n• A-1');
    expect(cleanPolishResult('<message>\nHi\n</message>')).toBe('Hi');
  });
});

describe('rendering', () => {
  it('renders links and escapes for Slack, URLs in brackets for plain text', () => {
    const item = { parts: [{ text: 'A-1', url: 'https://j.example.test/A-1' }, ' Fix <b> & co'] };
    expect(renderItem(item, 'slack')).toBe(
      '<https://j.example.test/A-1|A-1> Fix &lt;b&gt; &amp; co',
    );
    expect(renderItem(item, 'plain')).toBe('A-1 (https://j.example.test/A-1) Fix <b> & co');
  });

  it('turns "# Heading" lines into bold (Slack) or "Heading:" (plain)', () => {
    expect(renderMessage('# Done\n{{x}}', { x: '- a' }, 'slack')).toBe('*Done*\n- a');
    expect(renderMessage('# Done\n{{x}}', { x: '- a' }, 'plain')).toBe('Done:\n- a');
  });
});

const issue = (key: string, over: Partial<IssueDetail> = {}): IssueDetail => ({
  key,
  summary: `Summary ${key}`,
  status: 'In Progress',
  statusCategory: 'in_progress',
  priority: 'Medium',
  rank: key,
  issueType: 'Story',
  url: `https://jira.example.test/browse/${key}`,
  inOpenSprint: true,
  updatedAt: wednesday.toISOString(),
  completedAt: null,
  description: '',
  acceptanceCriteria: [],
  comments: [],
  ...over,
});

const mr = (iid: number, over: Partial<MergeRequest> = {}): MergeRequest => ({
  ref: { projectId: '1', iid },
  projectPath: 'acme/shop',
  title: `MR ${iid}`,
  description: '',
  sourceBranch: `b-${iid}`,
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
  linesAdded: 10,
  linesRemoved: 2,
  headSha: '',
  createdAt: at(2026, 1, 13, 9).toISOString(),
  updatedAt: at(2026, 1, 13, 9).toISOString(),
  mergedAt: null,
  ...over,
});

describe('daily report', () => {
  const settings = parseProfileSettings({});
  const mine = (m: MergeRequest) => ({
    mr: m,
    isMine: true,
    isReviewer: false,
    needsMyReview: false,
  });
  const workspace = buildWorkspace({
    now: wednesday,
    retentionDays: 7,
    issues: [
      issue('A-1', {
        statusCategory: 'done',
        status: 'Done',
        completedAt: at(2026, 1, 13, 15).toISOString(),
      }),
      issue('A-2', {
        statusCategory: 'done',
        status: 'Done',
        completedAt: at(2026, 1, 10, 15).toISOString(),
      }),
      issue('A-3'),
      issue('A-4'),
      issue('A-5', { status: 'Blocked' }),
      issue('A-6', { statusCategory: 'todo', status: 'To Do' }),
    ],
    mergeRequests: [
      mine(mr(1, { state: 'merged', mergedAt: at(2026, 1, 13, 14).toISOString() })),
      mine(
        mr(2, { state: 'merged', mergedAt: at(2026, 1, 13, 18).toISOString(), title: 'Bump deps' }),
      ),
      mine(mr(3, { pipelineStatus: 'failed' })),
      mine(mr(4, { createdAt: at(2026, 1, 11, 9).toISOString() })), // stale review
      mine(mr(5, { draft: true })),
    ],
    links: [
      { mrKey: '1!1', issueKey: 'A-1', source: 'branch' },
      { mrKey: '1!3', issueKey: 'A-3', source: 'branch' },
      { mrKey: '1!4', issueKey: 'A-4', source: 'branch' },
    ],
  });
  const window = dailyReportWindow(settings.timeWindows.dailyReport, wednesday, null);
  const report = buildDailyReport({
    workspace,
    settings,
    suggestions: buildSuggestions(workspace, settings),
    window,
    now: wednesday,
  });
  const plain = renderDailyReport(
    report,
    DEFAULT_MESSAGE_TEMPLATES['daily-report'],
    'plain',
    wednesday,
  );
  const slack = renderDailyReport(
    report,
    DEFAULT_MESSAGE_TEMPLATES['daily-report'],
    'slack',
    wednesday,
  );

  it('lists work done in the window, merged MRs under their ticket', () => {
    expect(plain).toContain(
      '- A-1 (https://jira.example.test/browse/A-1) Summary A-1 (merged !1 (https://gitlab.example.test/acme/shop/-/merge_requests/1))',
    );
    expect(plain).toContain(
      '- Merged !2 (https://gitlab.example.test/acme/shop/-/merge_requests/2) Bump deps',
    );
    expect(plain).not.toContain('A-2'); // completed before the window
  });

  it('shows in-progress tickets with MR status, and next steps', () => {
    expect(plain).toMatch(/A-3 \(.*\) Summary A-3: !3 \(.*\) pipeline failed/);
    expect(plain).toMatch(/A-5 \(.*\) Summary A-5 \(no MR yet\)/);
    expect(report.next.map((n) => renderItem(n, 'plain'))).toEqual([
      expect.stringMatching(/^Fix the pipeline on !3 \(.*\) MR 3$/),
      expect.stringMatching(/^A-6 \(.*\) Summary A-6$/),
    ]);
  });

  it('flags failing pipelines, stale reviews and blocked tickets', () => {
    const blockers = report.blockers.map((b) => renderItem(b, 'plain'));
    expect(blockers).toEqual([
      expect.stringContaining('MR 3: pipeline failing'),
      expect.stringMatching(/MR 4: waiting for review for 3d$/),
      expect.stringContaining('Summary A-5 (Blocked)'),
    ]);
  });

  it('renders Slack headings and links', () => {
    expect(slack.split('\n')[0]).toMatch(/^\*Update for Wed 14 Jan\*$/);
    expect(slack).toContain('*Blockers*');
    expect(slack).toContain('<https://jira.example.test/browse/A-1|A-1>');
  });

  it('builds the review request from my non-draft, unapproved MRs, oldest first', () => {
    const items = buildReviewRequest(workspace, wednesday);
    const text = renderReviewRequest(items, DEFAULT_MESSAGE_TEMPLATES['review-request'], 'plain');
    expect(text.split('\n')[0]).toBe('Could I get a review on these 2 merge requests, please?');
    expect(text).toMatch(/- A-4 \(.*\) MR 4 \(.*\) \(\+10 −2, open 3d\)\n- A-3/);
    expect(text).not.toContain('MR 5'); // draft

    const keyed = buildWorkspace({
      now: wednesday,
      retentionDays: 7,
      issues: [issue('A-9')],
      mergeRequests: [mine(mr(9, { title: 'A-9 Fix it' }))],
      links: [{ mrKey: '1!9', issueKey: 'A-9', source: 'title' }],
    });
    expect(renderItem(buildReviewRequest(keyed, wednesday)[0]!, 'plain')).toMatch(/^A-9 Fix it \(/);
  });
});
