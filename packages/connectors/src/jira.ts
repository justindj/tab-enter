import type { Issue, IssueComment, IssueDetail, StatusCategory, User } from '@tab-enter/core';
import { HttpClient, type HttpClientOptions } from './http';
import { extractAcceptanceCriteria, jiraText } from './jira-text';
import { ConnectorError, type IssueTracker } from './types';

// Jira Cloud and Data Center, read-only.
//
// Cloud: REST v3, POST /rest/api/3/search/jql (token pagination via
// nextPageToken/isLast; the old /rest/api/3/search was removed). Rich text is ADF.
// Data Center: REST v2, POST /rest/api/2/search (startAt/total pagination).
// Rich text is wiki markup. See docs/decisions.md ("Jira connector").

export interface JiraOptions {
  deployment: 'cloud' | 'datacenter';
  baseUrl: string;
  getHeaders: HttpClientOptions['getHeaders'];
  /** When set, "current sprint" means this board's active sprints. */
  boardId?: string;
  /** Status names to treat as done even if their category isn't Done. */
  doneStatuses?: string[];
  fetch?: HttpClientOptions['fetch'];
  sleep?: HttpClientOptions['sleep'];
  now?: () => Date;
  /** Safety cap on issues fetched per query. */
  maxIssues?: number;
}

interface JiraIssueJson {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string } | null;
    issuetype?: { name?: string };
    updated?: string;
    resolutiondate?: string | null;
    statuscategorychangedate?: string | null;
    description?: unknown;
    comment?: {
      comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[];
    };
  };
}

interface CloudSearchResponse {
  issues?: JiraIssueJson[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface DcSearchResponse {
  issues?: JiraIssueJson[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

const LIST_FIELDS = [
  'summary',
  'status',
  'priority',
  'issuetype',
  'updated',
  'resolutiondate',
  'statuscategorychangedate',
];
const DETAIL_FIELDS = [...LIST_FIELDS, 'description', 'comment'];
const PAGE_SIZE = 100;
const MAX_COMMENTS = 20;

/** JQL string literal. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class JiraIssueTracker implements IssueTracker {
  private readonly http: HttpClient;
  private readonly api: string;
  private readonly now: () => Date;
  /** Details fetched alongside searches, so getIssue needs no extra request during a sync. */
  private readonly details = new Map<string, IssueDetail>();
  private sprintClause: Promise<string | null> | null = null;

  constructor(private readonly opts: JiraOptions) {
    this.http = new HttpClient({
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
      getHeaders: opts.getHeaders,
      service: 'Jira',
      fetch: opts.fetch,
      sleep: opts.sleep,
    });
    this.api = opts.deployment === 'cloud' ? '/rest/api/3' : '/rest/api/2';
    this.now = opts.now ?? (() => new Date());
  }

  async getCurrentUser(): Promise<User> {
    const { data } = await this.http.get<{
      accountId?: string;
      name?: string;
      key?: string;
      displayName?: string;
      emailAddress?: string;
    }>(`${this.api}/myself`);
    const id = data.accountId ?? data.key ?? data.name;
    if (!id) throw new ConnectorError('other', 'Jira returned no user for this token.');
    return { id, displayName: data.displayName ?? id, username: data.name ?? data.emailAddress };
  }

  async listMyActiveIssues({ sprintOnly }: { sprintOnly: boolean }): Promise<Issue[]> {
    const base = `assignee = currentUser() AND ${this.notDoneClause()}`;
    const [all, inSprint] = await Promise.all([
      this.search(`${base} ORDER BY Rank ASC`),
      this.sprintKeys(base),
    ]);
    const issues = all.map((raw, i) => ({
      ...this.toDetail(raw),
      // Position in Jira's rank order, zero-padded so it sorts as a string.
      rank: String(i).padStart(6, '0'),
      inOpenSprint: inSprint === null || inSprint.has(raw.key),
    }));
    for (const issue of issues) this.details.set(issue.key, issue);
    return issues.filter((i) => !sprintOnly || i.inOpenSprint).map(toIssue);
  }

  async listMyRecentlyCompleted(since: Date): Promise<Issue[]> {
    // Relative minutes avoid JQL's "dates are in the user's timezone" rule.
    const minutes = Math.max(1, Math.ceil((this.now().getTime() - since.getTime()) / 60_000));
    const raws = await this.search(
      `assignee = currentUser() AND ${this.doneClause()} AND updated >= -${minutes}m ORDER BY updated DESC`,
    );
    const issues = raws
      .map((raw) => this.toDetail(raw))
      .filter((i) => i.completedAt && Date.parse(i.completedAt) >= since.getTime());
    for (const issue of issues) this.details.set(issue.key, issue);
    return issues.map(toIssue);
  }

  async getIssue(key: string): Promise<IssueDetail> {
    const cached = this.details.get(key);
    if (cached) return cached;
    const { data } = await this.http.get<JiraIssueJson>(
      `${this.api}/issue/${encodeURIComponent(key)}`,
      { fields: DETAIL_FIELDS.join(',') },
    );
    const detail = this.toDetail(data);
    this.details.set(key, detail);
    return detail;
  }

  async rankNextCandidates(): Promise<Issue[]> {
    const active = await this.listMyActiveIssues({ sprintOnly: true });
    return active.filter((i) => i.statusCategory === 'todo');
  }

  // ------------------------------------------------------------ internals

  private doneNames(): string[] {
    return this.opts.doneStatuses?.filter(Boolean) ?? [];
  }

  private notDoneClause(): string {
    const names = this.doneNames();
    return names.length
      ? `statusCategory != Done AND status not in (${names.map(jqlString).join(', ')})`
      : 'statusCategory != Done';
  }

  private doneClause(): string {
    const names = this.doneNames();
    return names.length
      ? `(statusCategory = Done OR status in (${names.map(jqlString).join(', ')}))`
      : 'statusCategory = Done';
  }

  /**
   * Keys of active issues in the current sprint, or null when sprints don't
   * apply (no Jira Software, or no sprint field), in which case every active
   * issue counts as current.
   */
  private async sprintKeys(base: string): Promise<Set<string> | null> {
    const clause = await this.getSprintClause();
    if (clause === null) return null;
    if (clause === '') return new Set(); // board has no active sprint
    try {
      const raws = await this.search(`${base} AND ${clause}`, ['summary']);
      return new Set(raws.map((r) => r.key));
    } catch (err) {
      // 400: the instance has no "sprint" field (Jira Work Management / Core).
      if (err instanceof ConnectorError && /\(400\)|returned 400/.test(err.message)) return null;
      throw err;
    }
  }

  private getSprintClause(): Promise<string | null> {
    this.sprintClause ??= (async () => {
      if (!this.opts.boardId) return 'sprint in openSprints()';
      const { data } = await this.http.get<{ values?: { id: number }[] }>(
        `/rest/agile/1.0/board/${encodeURIComponent(this.opts.boardId)}/sprint`,
        { state: 'active' },
      );
      const ids = (data.values ?? []).map((s) => s.id);
      return ids.length ? `sprint in (${ids.join(', ')})` : '';
    })();
    return this.sprintClause;
  }

  private async search(jql: string, fields = DETAIL_FIELDS): Promise<JiraIssueJson[]> {
    const cap = this.opts.maxIssues ?? 1000;
    const out: JiraIssueJson[] = [];
    if (this.opts.deployment === 'cloud') {
      let nextPageToken: string | undefined;
      do {
        const { data } = await this.http.post<CloudSearchResponse>(`${this.api}/search/jql`, {
          jql,
          fields,
          maxResults: PAGE_SIZE,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
        out.push(...(data.issues ?? []));
        nextPageToken = data.isLast ? undefined : data.nextPageToken;
      } while (nextPageToken && out.length < cap);
    } else {
      let startAt = 0;
      for (;;) {
        const { data } = await this.http.post<DcSearchResponse>(`${this.api}/search`, {
          jql,
          fields,
          startAt,
          maxResults: PAGE_SIZE,
        });
        const page = data.issues ?? [];
        out.push(...page);
        startAt += page.length;
        if (page.length === 0 || startAt >= (data.total ?? 0) || out.length >= cap) break;
      }
    }
    return out.slice(0, cap);
  }

  private category(raw: JiraIssueJson): StatusCategory {
    const name = raw.fields.status?.name ?? '';
    if (this.doneNames().some((d) => d.toLowerCase() === name.toLowerCase())) return 'done';
    switch (raw.fields.status?.statusCategory?.key) {
      case 'done':
        return 'done';
      case 'indeterminate':
        return 'in_progress';
      default:
        return 'todo';
    }
  }

  private toDetail(raw: JiraIssueJson): IssueDetail {
    const f = raw.fields;
    const category = this.category(raw);
    const description = jiraText(f.description);
    const comments: IssueComment[] = (f.comment?.comments ?? []).slice(-MAX_COMMENTS).map((c) => ({
      author: c.author?.displayName ?? 'Unknown',
      body: jiraText(c.body),
      createdAt: toIso(c.created) ?? '',
    }));
    return {
      key: raw.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? 'Unknown',
      statusCategory: category,
      priority: f.priority?.name ?? null,
      rank: null,
      issueType: f.issuetype?.name ?? 'Issue',
      url: `${this.http.baseUrl}/browse/${raw.key}`,
      inOpenSprint: false,
      updatedAt: toIso(f.updated) ?? this.now().toISOString(),
      completedAt:
        category === 'done'
          ? (toIso(f.resolutiondate) ?? toIso(f.statuscategorychangedate) ?? toIso(f.updated))
          : null,
      description,
      acceptanceCriteria: extractAcceptanceCriteria(description),
      comments,
    };
  }
}

/** Jira timestamps look like 2026-05-30T10:15:00.000+0000; normalise to ISO UTC. */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toIssue({
  description: _d,
  acceptanceCriteria: _a,
  comments: _c,
  ...issue
}: IssueDetail): Issue {
  return issue;
}
