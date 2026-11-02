import type { Issue, IssueDetail, MergeRequest, MRDetail, MRRef, User } from '@tab-enter/core';

// Every provider implements these. Adding Azure DevOps or GitHub later must
// not require UI changes, so nothing provider-specific leaks past here.

export interface IssueTracker {
  getCurrentUser(): Promise<User>;
  listMyActiveIssues(opts: { sprintOnly: boolean }): Promise<Issue[]>;
  listMyRecentlyCompleted(since: Date): Promise<Issue[]>;
  getIssue(key: string): Promise<IssueDetail>;
  /** Unstarted issues assigned to me, in priority/rank order. */
  rankNextCandidates(): Promise<Issue[]>;
}

export interface CodeHost {
  getCurrentUser(): Promise<User>;
  /** Authored by me. */
  listMyOpenMRs(): Promise<MergeRequest[]>;
  listMyRecentlyMergedMRs(since: Date): Promise<MergeRequest[]>;
  /** MRs where I'm a reviewer. */
  listReviewRequests(opts: { includeCompleted: boolean }): Promise<MergeRequest[]>;
  getMRDetail(ref: MRRef): Promise<MRDetail>;
}

export type ConnectorErrorKind = 'auth' | 'network' | 'rate_limit' | 'not_found' | 'other';

/** Errors the UI knows how to explain (expired token, VPN unreachable, ...). */
export class ConnectorError extends Error {
  constructor(
    public readonly kind: ConnectorErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
