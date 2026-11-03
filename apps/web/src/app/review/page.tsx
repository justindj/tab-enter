import { getDb, latestCodeReviews, listRecentRuns } from '@tab-enter/db';
import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { IssueLink } from '@/components/mr-table';
import { MRStatusBadges, PipelineBadge } from '@/components/mr-status';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AutoRefresh, ReviewButton, ReviewResultView, VERDICT_TONE } from './review-view';
import { VERDICT_LABELS } from '@tab-enter/core';

export default async function CodeReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show } = await searchParams;
  const showAll = show === 'all';
  const { workspace, active, now, runBlocker } = await loadApp();
  const db = await getDb();
  const [reviews, runs] = await Promise.all([
    latestCodeReviews(db, active.id),
    listRecentRuns(db, active.id, { limit: 100 }),
  ]);
  const reviewing = new Map(
    runs
      .filter(
        (r) => r.preset === 'code-review' && (r.status === 'queued' || r.status === 'running'),
      )
      .map((r) => [r.mrKey, r]),
  );
  const rows = workspace.reviews.filter((v) => showAll || v.needsMyReview);

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <AutoRefresh active={reviewing.size > 0} />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Code Review</h1>
        <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label="Filter">
          {[
            { label: 'Needs my review', href: '/review', on: !showAll },
            { label: 'All, including completed', href: '/review?show=all', on: showAll },
          ].map((o) => (
            <Link
              key={o.href}
              href={o.href}
              aria-pressed={o.on}
              className={cn(
                'rounded px-2 py-1',
                o.on ? 'bg-accent font-medium' : 'text-muted-foreground',
              )}
            >
              {o.label}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader
          title="Merge requests where I’m a reviewer"
          description={
            runBlocker
              ? `${runBlocker} Reviews with Claude are off until then.`
              : 'Claude reviews in a read-only worktree at the MR head. Approving stays your call: do it in GitLab.'
          }
        />
        {rows.length === 0 ? (
          <EmptyState title={showAll ? 'No review requests' : 'Nothing waiting on your review'}>
            {!showAll && 'Switch to “All” to see completed and approved reviews.'}
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {rows.map((v) => {
              const { mr } = v;
              const latest = reviews.get(v.key);
              const running = reviewing.get(v.key);
              const changed = !!latest && latest.reviewedSha !== mr.headSha;
              const open = mr.state === 'opened';
              return (
                <li key={v.key} className="grid gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                    <div className="min-w-0 flex-1">
                      <a
                        href={mr.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline"
                      >
                        {mr.title}
                      </a>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          !{mr.ref.iid} · {mr.projectPath} · by {mr.author} · +{mr.linesAdded} −
                          {mr.linesRemoved} · opened {timeAgo(mr.createdAt, now)}
                        </span>
                        {v.issueKeys.map((k) => (
                          <IssueLink key={k} issue={workspace.issuesByKey.get(k)} issueKey={k} />
                        ))}
                        {mr.unresolvedThreads > 0 && (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <MessageSquare className="h-3 w-3" /> {mr.unresolvedThreads}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <MRStatusBadges status={v.status} />
                      <PipelineBadge status={mr.pipelineStatus} />
                      {open && !v.needsMyReview && <Badge tone="success">Approved by me</Badge>}
                      {running ? (
                        <Link href={`/runs/${running.id}`}>
                          <Badge tone="info">Reviewing…</Badge>
                        </Link>
                      ) : latest ? (
                        changed ? (
                          <Badge tone="warning" title="New commits since the last Claude review">
                            Changed since review
                          </Badge>
                        ) : latest.result.review ? (
                          <Badge tone={VERDICT_TONE[latest.result.review.verdict]}>
                            Claude: {VERDICT_LABELS[latest.result.review.verdict]}
                          </Badge>
                        ) : (
                          <Badge tone="warning">Review needs a look</Badge>
                        )
                      ) : (
                        <Badge tone="muted">Not reviewed</Badge>
                      )}
                      {open && !running && (
                        <ReviewButton
                          mrKey={v.key}
                          blocker={runBlocker}
                          reviewed={!!latest}
                          changed={changed}
                        />
                      )}
                    </div>
                  </div>
                  {latest && (
                    <details open={v.needsMyReview && !running}>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Latest review
                      </summary>
                      <div className="mt-2">
                        <ReviewResultView
                          result={latest.result}
                          runId={latest.runId}
                          reviewedSha={latest.reviewedSha}
                          when={timeAgo(latest.createdAt, now)}
                        />
                      </div>
                    </details>
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
