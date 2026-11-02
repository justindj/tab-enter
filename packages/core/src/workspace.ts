import { deriveMRStatus, type DerivedMRStatus } from './mr-status';
import type { IssueDetail, LinkSource, MergeRequest } from './types';
import { mrKey } from './types';

// Assemble what the pages show from synced rows. Plain code, no I/O, so the
// Now / Active Work / Code Review views are unit-testable.

export interface WorkspaceInput {
  issues: IssueDetail[];
  mergeRequests: {
    mr: MergeRequest;
    isMine: boolean;
    isReviewer: boolean;
    needsMyReview: boolean;
  }[];
  links: { mrKey: string; issueKey: string; source: LinkSource }[];
  now: Date;
  retentionDays: number;
}

export interface MRView {
  key: string;
  mr: MergeRequest;
  status: DerivedMRStatus;
  issueKeys: string[];
  isMine: boolean;
  isReviewer: boolean;
  needsMyReview: boolean;
}

export interface IssueView {
  issue: IssueDetail;
  mrs: MRView[];
}

export interface Workspace {
  /** My open MRs. */
  inFlight: MRView[];
  /** Assigned to me, not in a Done-category status. */
  activeIssues: IssueView[];
  /** My open MRs with no linked ticket. */
  unlinkedMRs: MRView[];
  recentlyCompleted: { issues: IssueDetail[]; mrs: MRView[] };
  /** MRs where I'm a reviewer; those awaiting me first. */
  reviews: MRView[];
  issuesByKey: Map<string, IssueDetail>;
}

export function buildWorkspace(input: WorkspaceInput): Workspace {
  const cutoff = input.now.getTime() - input.retentionDays * 86_400_000;
  const issuesByKey = new Map(input.issues.map((i) => [i.key, i]));

  const keysByMr = new Map<string, string[]>();
  for (const link of input.links) {
    keysByMr.set(link.mrKey, [...(keysByMr.get(link.mrKey) ?? []), link.issueKey]);
  }

  const views: MRView[] = input.mergeRequests.map(({ mr, isMine, isReviewer, needsMyReview }) => ({
    key: mrKey(mr.ref),
    mr,
    status: deriveMRStatus(mr),
    issueKeys: keysByMr.get(mrKey(mr.ref)) ?? [],
    isMine,
    isReviewer,
    needsMyReview,
  }));

  const inFlight = views.filter((v) => v.isMine && v.mr.state === 'opened');
  const activeIssues = input.issues
    .filter((i) => i.statusCategory !== 'done')
    .sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
    .map((issue) => ({
      issue,
      mrs: views.filter((v) => v.isMine && v.issueKeys.includes(issue.key)),
    }));

  const recentIssues = input.issues
    .filter(
      (i) => i.statusCategory === 'done' && i.completedAt && Date.parse(i.completedAt) >= cutoff,
    )
    .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!));
  const recentMrs = views
    .filter(
      (v) =>
        v.isMine && v.mr.state === 'merged' && v.mr.mergedAt && Date.parse(v.mr.mergedAt) >= cutoff,
    )
    .sort((a, b) => Date.parse(b.mr.mergedAt!) - Date.parse(a.mr.mergedAt!));

  const reviews = views
    .filter((v) => v.isReviewer)
    .sort(
      (a, b) =>
        Number(b.needsMyReview) - Number(a.needsMyReview) ||
        Date.parse(a.mr.createdAt) - Date.parse(b.mr.createdAt),
    );

  return {
    inFlight,
    activeIssues,
    unlinkedMRs: inFlight.filter((v) => v.issueKeys.length === 0),
    recentlyCompleted: { issues: recentIssues, mrs: recentMrs },
    reviews,
    issuesByKey,
  };
}
