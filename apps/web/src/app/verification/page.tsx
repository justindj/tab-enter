import type { IssueDetail } from '@tab-enter/core';
import {
  getDb,
  listVerifications,
  type VerificationRow,
  type VerificationStatus,
} from '@tab-enter/db';
import Link from 'next/link';
import { AutoRefresh } from '@/app/review/review-view';
import { EmptyState } from '@/components/empty-state';
import { IssueLink } from '@/components/mr-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CopySummary, PostSummary, VerifyControls } from './controls';
import { STATUS } from './status';

const FILTERS = ['all', 'not_run', 'running', 'passed', 'issues_found', 'needs_coverage'] as const;

export default async function VerificationPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const filter = (FILTERS as readonly string[]).includes(statusParam ?? '') ? statusParam! : 'all';
  const { workspace, active, now } = await loadApp();
  const verifications = await listVerifications(await getDb(), active.id);
  const latest = new Map<string, VerificationRow>();
  const saved = new Set<string>();
  for (const v of verifications) {
    if (!latest.has(v.issueKey)) latest.set(v.issueKey, v);
    if (v.scriptBlobKey) saved.add(v.issueKey);
  }

  // Completed tickets (newest first), then active tickets whose MR is approved.
  const done = [...workspace.issuesByKey.values()]
    .filter((i) => i.assignedToMe !== false && i.statusCategory === 'done')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const approved = workspace.activeIssues
    .filter((v) => v.mrs.some((m) => m.mr.state === 'opened' && m.status.primary === 'approved'))
    .map((v) => v.issue);
  const candidates: { issue: IssueDetail; why: string }[] = [
    ...done.map((issue) => ({ issue, why: `Done ${timeAgo(issue.completedAt, now)}` })),
    ...approved.map((issue) => ({ issue, why: 'MR approved' })),
  ];
  const statusOf = (key: string): VerificationStatus => latest.get(key)?.status ?? 'not_run';
  const rows = candidates.filter((c) => filter === 'all' || statusOf(c.issue.key) === filter);
  const anyRunning = candidates.some((c) => statusOf(c.issue.key) === 'running');

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <AutoRefresh active={anyRunning} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Verification</h1>
        <div
          className="flex flex-wrap rounded-md border p-0.5 text-xs"
          role="group"
          aria-label="Filter"
        >
          {FILTERS.map((f) => (
            <Link
              key={f}
              href={f === 'all' ? '/verification' : `/verification?status=${f}`}
              aria-pressed={filter === f}
              className={cn(
                'rounded px-2 py-1',
                filter === f ? 'bg-accent font-medium' : 'text-muted-foreground',
              )}
            >
              {f === 'all' ? 'All' : STATUS[f].label}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader
          title="Completed and approved tickets"
          description="UI changes get a browser walkthrough (Claude writes the steps once; re-runs are free). Backend changes show test evidence. Each run produces a slideshow."
        />
        {rows.length === 0 ? (
          <EmptyState
            title={filter === 'all' ? 'No completed tickets yet' : 'Nothing with this status'}
          >
            Completed tickets from the last sync and tickets with an approved MR show here.
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {rows.map(({ issue, why }) => {
              const v = latest.get(issue.key);
              const status = statusOf(issue.key);
              return (
                <li key={issue.key} className="grid gap-1.5 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="min-w-0 flex-1">
                      <IssueLink issue={issue} issueKey={issue.key} />{' '}
                      <span className="font-medium">{issue.summary}</span>
                      <span className="block text-xs text-muted-foreground">
                        {why} · {issue.acceptanceCriteria.length} acceptance criteria
                        {v &&
                          v.status !== 'running' &&
                          ` · last verified ${timeAgo(v.finishedAt ?? v.createdAt, now)}`}
                        {v?.mode && ` · ${v.mode === 'ui' ? 'UI walkthrough' : 'test evidence'}`}
                      </span>
                    </span>
                    <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
                    <VerifyControls
                      issueKey={issue.key}
                      hasSavedScript={saved.has(issue.key)}
                      running={status === 'running'}
                    />
                  </div>
                  {v && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {v.blobKey && (
                        <Link
                          href={`/verification/${v.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          View slideshow
                        </Link>
                      )}
                      {v.runId && (
                        <Link
                          href={`/runs/${v.runId}`}
                          className="text-muted-foreground underline-offset-2 hover:underline"
                        >
                          Claude run
                        </Link>
                      )}
                      {v.summary && <CopySummary text={v.summary} />}
                      {v.summary && v.status !== 'running' && v.status !== 'failed' && (
                        <PostSummary
                          summary={v.summary}
                          mrKey={v.mrKey}
                          issueKey={issue.key}
                          allowGitlab={active.settings.writeActions.gitlabComment}
                          allowJira={active.settings.writeActions.jiraComment}
                        />
                      )}
                      {v.error && <span className="text-danger">{v.error}</span>}
                      {v.criteria && (
                        <span className="flex flex-wrap gap-1">
                          {v.criteria.map((c, i) => (
                            <Badge
                              key={i}
                              tone={
                                c.result === 'verified'
                                  ? 'success'
                                  : c.result === 'partial'
                                    ? 'warning'
                                    : 'danger'
                              }
                              title={c.text}
                            >
                              AC{i + 1}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
