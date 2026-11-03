// Domain types shared by connectors, the database layer, the worker and the UI.
// All timestamps are ISO-8601 strings so every type here is JSON-serializable
// (the worker job protocol and a future hosted version depend on that).

export const LOCAL_USER_ID = 'local';

export interface User {
  id: string;
  displayName: string;
  username?: string;
}

export type StatusCategory = 'todo' | 'in_progress' | 'done';

export interface Issue {
  key: string;
  summary: string;
  status: string;
  statusCategory: StatusCategory;
  priority: string | null;
  /** Jira's lexorank string; sorts lexicographically. */
  rank: string | null;
  issueType: string;
  url: string;
  inOpenSprint: boolean;
  updatedAt: string;
  completedAt: string | null;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDetail extends Issue {
  description: string;
  acceptanceCriteria: string[];
  comments: IssueComment[];
  /**
   * False for tickets synced only because an MR I review links to them (for
   * the review prompt). They never appear in my own work lists.
   */
  assignedToMe?: boolean;
}

export interface MRRef {
  projectId: string;
  iid: number;
}

export type PipelineStatus =
  'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'skipped' | 'manual' | 'none';

export type MRState = 'opened' | 'merged' | 'closed';

export interface MergeRequest {
  ref: MRRef;
  projectPath: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  state: MRState;
  draft: boolean;
  author: string;
  webUrl: string;
  /** GitLab's `detailed_merge_status`, kept verbatim. */
  detailedMergeStatus: string;
  hasConflicts: boolean;
  pipelineStatus: PipelineStatus;
  approvedBy: string[];
  approvalsRequired: number;
  unresolvedThreads: number;
  /** A reviewer has explicitly requested changes. */
  changesRequested: boolean;
  reviewers: string[];
  linesAdded: number;
  linesRemoved: number;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  /**
   * Unresolved review threads (first note of each, trimmed), synced for my
   * open MRs so feedback prompts can quote them. Absent on older rows.
   */
  threads?: MRThread[];
  /** Failed jobs of the head pipeline with a log tail, synced for my open MRs. */
  pipelineFailures?: PipelineFailure[];
}

export interface MRThread {
  author: string;
  body: string;
  filePath?: string;
  line?: number;
}

export interface PipelineFailure {
  job: string;
  stage: string;
  webUrl?: string;
  /** Last lines of the job log, ANSI codes stripped. Context builders trim it further. */
  logTail: string;
}

export interface MRDiscussionNote {
  author: string;
  body: string;
  createdAt: string;
  filePath?: string;
  line?: number;
}

export interface MRDetail extends MergeRequest {
  diff: { path: string; diff: string }[];
  discussions: { id: string; resolved: boolean; notes: MRDiscussionNote[] }[];
}

export type LinkSource = 'branch' | 'title' | 'description' | 'manual';

export interface MRIssueLink {
  issueKey: string;
  source: LinkSource;
}

export interface ManualLink {
  mrKey: string;
  issueKey: string;
  action: 'link' | 'unlink';
}

/** Stable string key for an MR, e.g. "42!17". */
export function mrKey(ref: MRRef): string {
  return `${ref.projectId}!${ref.iid}`;
}

export interface ToolStatus {
  tool: 'claude' | 'rtk';
  installed: boolean;
  path: string | null;
  version: string | null;
  minimumVersion: string | null;
  meetsMinimum: boolean | null;
  /** null when it can't be determined (e.g. the CLI has no status command). */
  loggedIn: boolean | null;
  detail: string | null;
  checkedAt: string;
}
