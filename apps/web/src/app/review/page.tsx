import Link from 'next/link';
import { ComingSoon, EmptyState } from '@/components/empty-state';
import { MRTable } from '@/components/mr-table';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { cn } from '@/lib/utils';

export default async function CodeReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show } = await searchParams;
  const showAll = show === 'all';
  const { workspace, now } = await loadApp();
  const rows = workspace.reviews.filter((v) => showAll || v.needsMyReview);

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
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
        <CardHeader title="Merge requests where I’m a reviewer" />
        {rows.length === 0 ? (
          <EmptyState title={showAll ? 'No review requests' : 'Nothing waiting on your review'} />
        ) : (
          <MRTable rows={rows} issuesByKey={workspace.issuesByKey} now={now} showAuthor />
        )}
      </Card>

      <Card>
        <CardBody>
          <ComingSoon milestone="M5">
            Review with Claude (read-only tools, structured blockers, suggestions and questions),
            incremental re-reviews, and copy actions. Approving always stays a human click.
          </ComingSoon>
        </CardBody>
      </Card>
    </div>
  );
}
