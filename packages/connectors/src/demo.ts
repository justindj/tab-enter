import type { Issue, IssueDetail, MergeRequest, MRDetail, MRRef, User } from '@tab-enter/core';
import { ConnectorError, type CodeHost, type IssueTracker } from './types';

// Demo mode: connectors backed by the invented data in fixtures/demo. All
// timestamps are shifted so the fixture's `anchor` lands on "now", which keeps
// the demo looking fresh (recently completed, waiting times) on any date.

export interface DemoJiraFixture {
  anchor: string;
  currentUser: User;
  issues: IssueDetail[];
}

export type DemoMR = MRDetail & { role: 'author' | 'reviewer' };

export interface DemoGitLabFixture {
  anchor: string;
  currentUser: User;
  mergeRequests: DemoMR[];
}

function shiftDates<T>(value: T, deltaMs: number): T {
  if (Array.isArray(value)) return value.map((v) => shiftDates(v, deltaMs)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        typeof v === 'string' && k.endsWith('At') && !Number.isNaN(Date.parse(v))
          ? new Date(Date.parse(v) + deltaMs).toISOString()
          : shiftDates(v, deltaMs);
    }
    return out as T;
  }
  return value;
}

function anchored<T extends { anchor: string }>(fixture: T, now: Date): T {
  return shiftDates(fixture, now.getTime() - Date.parse(fixture.anchor));
}

function toIssue({
  description: _d,
  acceptanceCriteria: _a,
  comments: _c,
  ...issue
}: IssueDetail): Issue {
  return issue;
}

function toMR({ role: _r, diff: _d, discussions: _ds, ...mr }: DemoMR): MergeRequest {
  return mr;
}

export class DemoIssueTracker implements IssueTracker {
  private readonly data: DemoJiraFixture;

  constructor(fixture: DemoJiraFixture, now = new Date()) {
    this.data = anchored(fixture, now);
  }

  async getCurrentUser() {
    return this.data.currentUser;
  }

  async listMyActiveIssues({ sprintOnly }: { sprintOnly: boolean }) {
    return this.data.issues
      .filter((i) => i.statusCategory !== 'done' && (!sprintOnly || i.inOpenSprint))
      .map(toIssue);
  }

  async listMyRecentlyCompleted(since: Date) {
    return this.data.issues
      .filter(
        (i) =>
          i.statusCategory === 'done' &&
          i.completedAt &&
          Date.parse(i.completedAt) >= since.getTime(),
      )
      .map(toIssue);
  }

  async getIssue(key: string) {
    const issue = this.data.issues.find((i) => i.key === key);
    if (!issue) throw new ConnectorError('not_found', `Issue ${key} not found`);
    return issue;
  }

  async rankNextCandidates() {
    return this.data.issues
      .filter((i) => i.statusCategory === 'todo' && i.inOpenSprint)
      .sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
      .map(toIssue);
  }
}

export class DemoCodeHost implements CodeHost {
  private readonly data: DemoGitLabFixture;

  constructor(fixture: DemoGitLabFixture, now = new Date()) {
    this.data = anchored(fixture, now);
  }

  private get me() {
    return this.data.currentUser.username ?? this.data.currentUser.id;
  }

  async getCurrentUser() {
    return this.data.currentUser;
  }

  async listMyOpenMRs() {
    return this.data.mergeRequests
      .filter((m) => m.role === 'author' && m.state === 'opened')
      .map(toMR);
  }

  async listMyRecentlyMergedMRs(since: Date) {
    return this.data.mergeRequests
      .filter(
        (m) =>
          m.role === 'author' &&
          m.state === 'merged' &&
          m.mergedAt &&
          Date.parse(m.mergedAt) >= since.getTime(),
      )
      .map(toMR);
  }

  async listReviewRequests({ includeCompleted }: { includeCompleted: boolean }) {
    return this.data.mergeRequests
      .filter(
        (m) =>
          m.role === 'reviewer' &&
          (includeCompleted || (m.state === 'opened' && !m.approvedBy.includes(this.me))),
      )
      .map(toMR);
  }

  async getMRDetail(ref: MRRef) {
    const mr = this.data.mergeRequests.find(
      (m) => m.ref.projectId === ref.projectId && m.ref.iid === ref.iid,
    );
    if (!mr) throw new ConnectorError('not_found', `MR ${ref.projectId}!${ref.iid} not found`);
    const { role: _r, ...detail } = mr;
    return detail;
  }
}
