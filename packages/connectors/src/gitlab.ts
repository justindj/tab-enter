import {
  stripAnsi,
  type MergeRequest,
  type MRDetail,
  type MRRef,
  type MRState,
  type MRThread,
  type PipelineFailure,
  type PipelineStatus,
  type User,
  type WatchedProject,
} from '@tab-enter/core';
import { HttpClient, mapLimit, type HttpClientOptions } from './http';
import { ConnectorError, type CodeHost } from './types';

// GitLab (gitlab.com or self-managed), REST v4, read-only. A read_api token is
// enough. List endpoints don't include the head pipeline, approvals or thread
// counts, so each MR costs a few extra requests (bounded concurrency). See
// docs/decisions.md ("GitLab connector").

export interface GitLabOptions {
  /** Instance URL without /api/v4, e.g. https://gitlab.com */
  baseUrl: string;
  getHeaders: HttpClientOptions['getHeaders'];
  /** When non-empty, only MRs in these projects are returned. */
  projects?: Pick<WatchedProject, 'id' | 'path'>[];
  /** How far back completed reviews go when includeCompleted is set. */
  completedSince?: Date;
  fetch?: HttpClientOptions['fetch'];
  sleep?: HttpClientOptions['sleep'];
  concurrency?: number;
}

interface GlUser {
  id: number;
  username: string;
  name?: string;
}

interface GlMR {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  author?: { username?: string };
  reviewers?: { username?: string }[];
  web_url: string;
  detailed_merge_status?: string;
  merge_status?: string;
  has_conflicts?: boolean;
  sha?: string | null;
  diff_refs?: { head_sha?: string } | null;
  head_pipeline?: { id?: number; status?: string } | null;
  references?: { full?: string };
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
}

interface GlApprovals {
  approved_by?: { user?: { username?: string } }[];
  approvals_required?: number;
}

interface GlNote {
  id: number;
  body: string;
  author?: { username?: string };
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: { new_path?: string; new_line?: number | null; old_path?: string } | null;
}

interface GlDiscussion {
  id: string;
  individual_note?: boolean;
  notes?: GlNote[];
}

interface GlDiff {
  old_path: string;
  new_path: string;
  diff: string;
  too_large?: boolean;
  collapsed?: boolean;
}

interface GlJob {
  id: number;
  name: string;
  stage: string;
  web_url?: string;
  allow_failure?: boolean;
}

const MAX_FAILED_JOBS = 3;
const MAX_LOG_LINES = 300;
const MAX_THREADS = 20;
const MAX_THREAD_BODY = 2000;

/** First note of each unresolved thread: what the reviewer asked for. */
export function unresolvedThreads(discussions: GlDiscussion[]): MRThread[] {
  return discussions
    .filter((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved))
    .slice(0, MAX_THREADS)
    .map((d) => {
      const first = (d.notes ?? []).find((n) => !n.system) ?? d.notes![0]!;
      const replies = (d.notes ?? []).filter((n) => n !== first && !n.system);
      const body = [
        first.body,
        ...replies.map((r) => `↳ ${r.author?.username ?? 'unknown'}: ${r.body}`),
      ]
        .join('\n')
        .slice(0, MAX_THREAD_BODY);
      return {
        author: first.author?.username ?? 'unknown',
        body,
        ...(first.position?.new_path ? { filePath: first.position.new_path } : {}),
        ...(first.position?.new_line ? { line: first.position.new_line } : {}),
      };
    });
}

const PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_DIFF_PAGES = 5;

export function mapPipelineStatus(status: string | null | undefined): PipelineStatus {
  switch (status) {
    case 'success':
    case 'failed':
    case 'running':
    case 'skipped':
    case 'manual':
      return status;
    case 'canceled':
    case 'canceling':
      return 'canceled';
    case 'created':
    case 'pending':
    case 'preparing':
    case 'scheduled':
    case 'waiting_for_resource':
      return 'pending';
    default:
      return 'none';
  }
}

function mapState(state: string): MRState {
  if (state === 'merged' || state === 'closed') return state;
  return 'opened'; // "locked" is an opened MR mid-merge
}

/** Lines added/removed in a unified diff body (GitLab omits the ---/+++ headers). */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

/** A thread counts as unresolved when it has a resolvable note that isn't resolved. */
export function countUnresolved(discussions: GlDiscussion[]): number {
  return discussions.filter((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved)).length;
}

export class GitLabCodeHost implements CodeHost {
  private readonly http: HttpClient;
  private me: Promise<GlUser> | null = null;

  constructor(private readonly opts: GitLabOptions) {
    this.http = new HttpClient({
      baseUrl: `${opts.baseUrl.replace(/\/+$/, '')}/api/v4`,
      getHeaders: opts.getHeaders,
      service: 'GitLab',
      fetch: opts.fetch,
      sleep: opts.sleep,
    });
  }

  async getCurrentUser(): Promise<User> {
    const me = await this.currentUser();
    return { id: String(me.id), displayName: me.name ?? me.username, username: me.username };
  }

  async listMyOpenMRs(): Promise<MergeRequest[]> {
    const raws = await this.list({ scope: 'created_by_me', state: 'opened' });
    // Only my own MRs get thread text and failed-job logs, for feedback/pipeline prompts.
    return this.enrichAll(raws, { forPrompts: true });
  }

  async listMyRecentlyMergedMRs(since: Date): Promise<MergeRequest[]> {
    const raws = await this.list({
      scope: 'created_by_me',
      state: 'merged',
      updated_after: since.toISOString(),
    });
    const recent = raws.filter((m) => m.merged_at && Date.parse(m.merged_at) >= since.getTime());
    return this.enrichAll(recent);
  }

  async listReviewRequests({
    includeCompleted,
  }: {
    includeCompleted: boolean;
  }): Promise<MergeRequest[]> {
    const me = await this.currentUser();
    const base = { scope: 'all', reviewer_id: me.id };
    const open = await this.list({ ...base, state: 'opened' });
    const merged =
      includeCompleted && this.opts.completedSince
        ? await this.list({
            ...base,
            state: 'merged',
            updated_after: this.opts.completedSince.toISOString(),
          })
        : [];
    const mrs = await this.enrichAll([...open, ...merged]);
    return includeCompleted
      ? mrs
      : mrs.filter((m) => m.state === 'opened' && !m.approvedBy.includes(me.username));
  }

  async getMRDetail(ref: MRRef): Promise<MRDetail> {
    const { mr, discussions, diffs } = await this.load(ref, {
      withDiscussions: true,
      withDiffs: true,
    });
    return {
      ...mr,
      diff: diffs.map((d) => ({ path: d.new_path, diff: d.too_large ? '' : d.diff })),
      discussions: discussions
        .filter((d) => (d.notes ?? []).some((n) => !n.system))
        .map((d) => {
          const notes = (d.notes ?? []).filter((n) => !n.system);
          return {
            id: d.id,
            resolved: notes.every((n) => !n.resolvable || n.resolved),
            notes: notes.map((n) => ({
              author: n.author?.username ?? 'unknown',
              body: n.body,
              createdAt: n.created_at,
              ...(n.position?.new_path ? { filePath: n.position.new_path } : {}),
              ...(n.position?.new_line ? { line: n.position.new_line } : {}),
            })),
          };
        }),
    };
  }

  // ------------------------------------------------------------ internals

  private currentUser(): Promise<GlUser> {
    this.me ??= this.http.get<GlUser>('/user').then((r) => r.data);
    this.me.catch(() => (this.me = null));
    return this.me;
  }

  private watched(mr: GlMR): boolean {
    const projects = this.opts.projects ?? [];
    if (projects.length === 0) return true;
    const path = projectPath(mr);
    return projects.some((p) => p.id === String(mr.project_id) || (p.path && p.path === path));
  }

  private async paginate<T>(
    path: string,
    query: Record<string, string | number>,
    maxPages: number,
  ) {
    const out: T[] = [];
    let page: string | null = '1';
    for (let i = 0; page && i < maxPages; i++) {
      const res: { data: T[]; headers: Headers } = await this.http.get<T[]>(path, {
        ...query,
        per_page: PER_PAGE,
        page,
      });
      out.push(...res.data);
      page = res.headers.get('x-next-page') || null;
    }
    return out;
  }

  private async list(query: Record<string, string | number>): Promise<GlMR[]> {
    const raws = await this.paginate<GlMR>('/merge_requests', query, MAX_PAGES);
    return raws.filter((m) => this.watched(m));
  }

  private mrPath(ref: MRRef): string {
    return `/projects/${encodeURIComponent(ref.projectId)}/merge_requests/${ref.iid}`;
  }

  private async single(ref: MRRef): Promise<GlMR> {
    return (await this.http.get<GlMR>(this.mrPath(ref))).data;
  }

  private async discussions(ref: MRRef): Promise<GlDiscussion[]> {
    return this.paginate<GlDiscussion>(`${this.mrPath(ref)}/discussions`, {}, MAX_PAGES);
  }

  private async diffs(ref: MRRef): Promise<GlDiff[]> {
    try {
      return await this.paginate<GlDiff>(`${this.mrPath(ref)}/diffs`, {}, MAX_DIFF_PAGES);
    } catch (err) {
      // /diffs is GitLab 15.7+; older instances get no line counts rather than a failed sync.
      if (err instanceof ConnectorError && err.kind === 'not_found') return [];
      throw err;
    }
  }

  private async approvals(ref: MRRef): Promise<GlApprovals> {
    try {
      return (await this.http.get<GlApprovals>(`${this.mrPath(ref)}/approvals`)).data;
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'not_found') return {};
      throw err;
    }
  }

  /**
   * List rows lack the pipeline, approvals and threads, so each MR is fetched
   * again. Threads and line counts only matter while an MR is open.
   */
  private enrichAll(raws: GlMR[], { forPrompts = false } = {}): Promise<MergeRequest[]> {
    return mapLimit(raws, this.opts.concurrency ?? 4, async (row) => {
      const open = row.state === 'opened';
      const ref = { projectId: String(row.project_id), iid: row.iid };
      const { mr, discussions, raw } = await this.load(ref, {
        withDiscussions: open,
        withDiffs: open,
      });
      if (!open || !forPrompts) return mr;
      const threads = unresolvedThreads(discussions);
      const failures =
        mr.pipelineStatus === 'failed' && raw.head_pipeline?.id
          ? await this.pipelineFailures(ref.projectId, raw.head_pipeline.id)
          : [];
      return {
        ...mr,
        ...(threads.length ? { threads } : {}),
        ...(failures.length ? { pipelineFailures: failures } : {}),
      };
    });
  }

  /** Failed jobs of a pipeline with the end of each log (best effort: errors give none). */
  private async pipelineFailures(
    projectId: string,
    pipelineId: number,
  ): Promise<PipelineFailure[]> {
    const project = `/projects/${encodeURIComponent(projectId)}`;
    try {
      const { data: jobs } = await this.http.get<GlJob[]>(
        `${project}/pipelines/${pipelineId}/jobs`,
        { 'scope[]': 'failed', per_page: PER_PAGE },
      );
      return await mapLimit(
        jobs.filter((j) => !j.allow_failure).slice(0, MAX_FAILED_JOBS),
        2,
        async (job) => {
          const log = await this.http
            .getText(`${project}/jobs/${job.id}/trace`)
            .catch(() => '(log unavailable)');
          return {
            job: job.name,
            stage: job.stage,
            ...(job.web_url ? { webUrl: job.web_url } : {}),
            logTail: stripAnsi(log).split('\n').slice(-MAX_LOG_LINES).join('\n'),
          };
        },
      );
    } catch (err) {
      if (err instanceof ConnectorError && err.kind !== 'network') return [];
      throw err;
    }
  }

  private async load(
    ref: MRRef,
    { withDiscussions, withDiffs }: { withDiscussions: boolean; withDiffs: boolean },
  ): Promise<{ mr: MergeRequest; raw: GlMR; discussions: GlDiscussion[]; diffs: GlDiff[] }> {
    const [raw, approvals, discussions, diffs] = await Promise.all([
      this.single(ref),
      this.approvals(ref),
      withDiscussions ? this.discussions(ref) : Promise.resolve([]),
      withDiffs ? this.diffs(ref) : Promise.resolve([]),
    ]);
    const lines = diffs.reduce(
      (acc, d) => {
        const c = countDiffLines(d.diff);
        return { added: acc.added + c.added, removed: acc.removed + c.removed };
      },
      { added: 0, removed: 0 },
    );
    const detailed = raw.detailed_merge_status ?? raw.merge_status ?? 'unchecked';
    const mr: MergeRequest = {
      ref,
      projectPath: projectPath(raw),
      title: raw.title,
      description: raw.description ?? '',
      sourceBranch: raw.source_branch,
      targetBranch: raw.target_branch,
      state: mapState(raw.state),
      draft: Boolean(raw.draft ?? raw.work_in_progress),
      author: raw.author?.username ?? 'unknown',
      webUrl: raw.web_url,
      detailedMergeStatus: detailed,
      hasConflicts: Boolean(raw.has_conflicts) || detailed === 'conflict',
      pipelineStatus: mapPipelineStatus(raw.head_pipeline?.status),
      approvedBy: (approvals.approved_by ?? [])
        .map((a) => a.user?.username)
        .filter((u): u is string => Boolean(u)),
      approvalsRequired: approvals.approvals_required ?? 0,
      unresolvedThreads: countUnresolved(discussions),
      changesRequested: detailed === 'requested_changes',
      reviewers: (raw.reviewers ?? [])
        .map((r) => r.username)
        .filter((u): u is string => Boolean(u)),
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      headSha: raw.diff_refs?.head_sha ?? raw.sha ?? '',
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      mergedAt: raw.merged_at ?? null,
    };
    return { mr, raw, discussions, diffs };
  }
}

/** "group/sub/project" from references.full ("group/sub/project!12") or the web URL. */
function projectPath(mr: GlMR): string {
  const full = mr.references?.full;
  if (full?.includes('!')) return full.slice(0, full.lastIndexOf('!'));
  const match = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(mr.web_url);
  return match?.[1] ?? String(mr.project_id);
}
