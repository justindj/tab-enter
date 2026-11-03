import { MR_STATUS_LABELS, type MRStatus } from './mr-status';
import type { IssueView, MRView } from './workspace';

// Filtering, sorting and grouping for the Active Work page. Plain functions so
// the page can run them client-side and they stay unit-tested.

export type ActiveSort = 'rank' | 'priority' | 'status' | 'updated' | 'key';
export type MRFilter = 'any' | 'has' | 'none';

export interface ActiveFilters {
  sprintOnly: boolean;
  /** Matches ticket key, summary, and linked MR titles/branches (case-insensitive). */
  text: string;
  /** Jira status names; empty = all. */
  statuses: string[];
  /** Priority names; empty = all. "None" matches tickets without a priority. */
  priorities: string[];
  mr: MRFilter;
  /** Only tickets with a linked MR whose primary status is this. */
  mrStatus: MRStatus | null;
}

export const DEFAULT_ACTIVE_FILTERS: ActiveFilters = {
  sprintOnly: true,
  text: '',
  statuses: [],
  priorities: [],
  mr: 'any',
  mrStatus: null,
};

export const NO_PRIORITY = 'None';

// Jira's default schemes (Cloud and Data Center). Unknown names sort in the middle.
const PRIORITY_ORDER: Record<string, number> = {
  highest: 0,
  blocker: 0,
  critical: 1,
  high: 1,
  major: 2,
  medium: 3,
  low: 4,
  minor: 4,
  lowest: 5,
  trivial: 5,
};

export function priorityRank(priority: string | null): number {
  if (!priority) return 6;
  return PRIORITY_ORDER[priority.toLowerCase()] ?? 3;
}

const CATEGORY_ORDER = { todo: 0, in_progress: 1, done: 2 } as const;

function matchesText(view: IssueView, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const { issue, mrs } = view;
  return [
    issue.key,
    issue.summary,
    ...mrs.flatMap((m) => [m.mr.title, m.mr.sourceBranch, `!${m.mr.ref.iid}`]),
  ].some((s) => s.toLowerCase().includes(q));
}

/** Only my open MRs count towards "has an MR"; merged ones mean the ticket's MR work is done. */
export function openMRs(view: IssueView): MRView[] {
  return view.mrs.filter((m) => m.mr.state === 'opened');
}

export function filterActiveWork(views: IssueView[], f: ActiveFilters): IssueView[] {
  return views.filter((v) => {
    const { issue } = v;
    if (f.sprintOnly && !issue.inOpenSprint) return false;
    if (f.statuses.length && !f.statuses.includes(issue.status)) return false;
    if (f.priorities.length && !f.priorities.includes(issue.priority ?? NO_PRIORITY)) return false;
    const open = openMRs(v);
    if (f.mr === 'has' && open.length === 0) return false;
    if (f.mr === 'none' && open.length > 0) return false;
    if (f.mrStatus && !open.some((m) => m.status.primary === f.mrStatus)) return false;
    return matchesText(v, f.text);
  });
}

export function sortActiveWork(
  views: IssueView[],
  sort: ActiveSort,
  direction: 'asc' | 'desc' = 'asc',
): IssueView[] {
  const byRank = (a: IssueView, b: IssueView) =>
    (a.issue.rank ?? '￿').localeCompare(b.issue.rank ?? '￿');
  const compare: Record<ActiveSort, (a: IssueView, b: IssueView) => number> = {
    rank: byRank,
    priority: (a, b) => priorityRank(a.issue.priority) - priorityRank(b.issue.priority),
    status: (a, b) =>
      CATEGORY_ORDER[a.issue.statusCategory] - CATEGORY_ORDER[b.issue.statusCategory] ||
      a.issue.status.localeCompare(b.issue.status),
    // Most recently updated first when ascending, which is what people expect.
    updated: (a, b) => Date.parse(b.issue.updatedAt) - Date.parse(a.issue.updatedAt),
    key: (a, b) => a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }),
  };
  const sign = direction === 'asc' ? 1 : -1;
  // Rank breaks ties so equal rows keep Jira's order.
  return [...views].sort((a, b) => sign * compare[sort](a, b) || byRank(a, b));
}

export interface StatusGroup {
  status: string;
  issues: IssueView[];
}

/**
 * Group by Jira status like board columns. Jira's column order needs board
 * config we don't fetch, so columns go To Do → In Progress category, then in
 * order of first appearance in rank order. Issues keep their given order.
 */
export function groupByStatus(views: IssueView[]): StatusGroup[] {
  const groups = new Map<string, { group: StatusGroup; category: number; firstRank: string }>();
  for (const v of views) {
    const entry = groups.get(v.issue.status);
    if (entry) {
      entry.group.issues.push(v);
      const rank = v.issue.rank ?? '￿';
      if (rank < entry.firstRank) entry.firstRank = rank;
    } else {
      groups.set(v.issue.status, {
        group: { status: v.issue.status, issues: [v] },
        category: CATEGORY_ORDER[v.issue.statusCategory],
        firstRank: v.issue.rank ?? '￿',
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.category - b.category || a.firstRank.localeCompare(b.firstRank))
    .map((e) => e.group);
}

/** Options for the filter controls, from the data actually present. */
export function activeFilterOptions(views: IssueView[]) {
  const statuses = groupByStatus(sortActiveWork(views, 'rank')).map((g) => g.status);
  const priorities = [...new Set(views.map((v) => v.issue.priority ?? NO_PRIORITY))].sort(
    (a, b) =>
      priorityRank(a === NO_PRIORITY ? null : a) - priorityRank(b === NO_PRIORITY ? null : b),
  );
  const mrStatuses = [
    ...new Set(views.flatMap((v) => openMRs(v).map((m) => m.status.primary))),
  ].sort(
    (a, b) => Object.keys(MR_STATUS_LABELS).indexOf(a) - Object.keys(MR_STATUS_LABELS).indexOf(b),
  );
  return { statuses, priorities, mrStatuses };
}

/** The most urgent primary status among a ticket's open MRs, for the collapsed row. */
export function worstMRStatus(view: IssueView): MRStatus | null {
  const order = Object.keys(MR_STATUS_LABELS) as MRStatus[];
  const statuses = openMRs(view).map((m) => m.status.primary);
  if (statuses.length === 0) return null;
  return statuses.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!;
}
