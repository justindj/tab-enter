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

// Write operations, used only by confirmed, logged write actions (M7).

export interface CodeHostWriter {
  postNote(ref: MRRef, body: string): Promise<{ url: string }>;
  /** A comment on a diff line; throws when GitLab can't place it on the diff. */
  postDiffNote(
    ref: MRRef,
    c: { file: string; line: number; body: string },
  ): Promise<{ url: string }>;
  /** Approve only if the MR head is still `sha`. */
  approve(ref: MRRef, sha: string): Promise<void>;
  createMergeRequest(input: {
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<{ url: string; iid: number }>;
}

export interface IssueTrackerWriter {
  addComment(key: string, body: string): Promise<{ url: string }>;
  listTransitions(key: string): Promise<{ id: string; name: string; to: string }[]>;
  transition(key: string, transitionId: string): Promise<void>;
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
