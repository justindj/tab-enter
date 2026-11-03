import { deriveMRStatus, type DerivedMRStatus } from './mr-status';
import type { IssueDetail, LinkSource, ManualLink, MergeRequest, MRIssueLink } from './types';
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
  /** Manual overrides; only the "unlink" ones are surfaced (so they can be undone). */
  manual?: ManualLink[];
  now: Date;
  retentionDays: number;
}

export interface MRView {
  key: string;
  mr: MergeRequest;
  status: DerivedMRStatus;
  issueKeys: string[];
  /** Same keys as issueKeys, with the rule (or manual action) that linked each. */
  links: MRIssueLink[];
  /** Keys the rules found but the user unlinked. */
  unlinkedKeys: string[];
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
  /** Every synced MR (mine and reviews), for reports with their own time window. */
  mergeRequests: MRView[];
}

export function buildWorkspace(input: WorkspaceInput): Workspace {
  const cutoff = input.now.getTime() - input.retentionDays * 86_400_000;
  const issuesByKey = new Map(input.issues.map((i) => [i.key, i]));

  const linksByMr = new Map<string, MRIssueLink[]>();
  for (const { mrKey: key, issueKey, source } of input.links) {
    linksByMr.set(key, [...(linksByMr.get(key) ?? []), { issueKey, source }]);
  }
  const unlinkedByMr = new Map<string, string[]>();
  for (const m of input.manual ?? []) {
    if (m.action === 'unlink') {
      unlinkedByMr.set(m.mrKey, [...(unlinkedByMr.get(m.mrKey) ?? []), m.issueKey]);
    }
  }

  const views: MRView[] = input.mergeRequests.map(({ mr, isMine, isReviewer, needsMyReview }) => {
    const key = mrKey(mr.ref);
    const links = linksByMr.get(key) ?? [];
    return {
      key,
      mr,
      status: deriveMRStatus(mr),
      issueKeys: links.map((l) => l.issueKey),
      links,
      unlinkedKeys: unlinkedByMr.get(key) ?? [],
      isMine,
      isReviewer,
      needsMyReview,
    };
  });

  const inFlight = views.filter((v) => v.isMine && v.mr.state === 'opened');
  const myIssues = input.issues.filter((i) => i.assignedToMe !== false);
  const activeIssues = myIssues
    .filter((i) => i.statusCategory !== 'done')
    .sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
    .map((issue) => ({
      issue,
      mrs: views.filter((v) => v.isMine && v.issueKeys.includes(issue.key)),
    }));

  const recentIssues = myIssues
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
    mergeRequests: views,
  };
}
