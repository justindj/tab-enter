import Link from 'next/link';
import { ComingSoon, EmptyState } from '@/components/empty-state';
import { IssueLink, MRTable } from '@/components/mr-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { plural, timeAgo } from '@/lib/format';

export default async function NowPage() {
  const { workspace, active, tools, now } = await loadApp();
  const { inFlight, recentlyCompleted, issuesByKey } = workspace;
  const claude = tools.claude;
  const retention = active.settings.timeWindows.recentRetentionDays;

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <h1 className="text-lg font-semibold">Now</h1>

      <Card>
        <CardHeader
          title="In flight"
          description={`${plural(inFlight.length, 'open merge request')} of mine`}
        />
        {inFlight.length === 0 ? (
          <EmptyState title="No open merge requests">
            Start the next ticket from Up next below.
          </EmptyState>
        ) : (
          <MRTable rows={inFlight} issuesByKey={issuesByKey} now={now} />
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Claude Code runs"
            description={
              claude?.installed
                ? `claude ${claude.version ?? ''} detected`
                : 'Claude Code is not installed. See Settings.'
            }
          />
          <CardBody>
            {active.settings.claude.approvedForClient ? (
              <ComingSoon milestone="M3">
                Live and recent runs, with tokens, cost and session links.
              </ComingSoon>
            ) : (
              <EmptyState title="Claude Code is not approved for this client">
                Turn it on in{' '}
                <Link href="/settings" className="underline">
                  Settings
                </Link>
                . Until then, AI actions become Copy prompt.
              </EmptyState>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recently completed" description={`Last ${plural(retention, 'day')}`} />
          {recentlyCompleted.issues.length + recentlyCompleted.mrs.length === 0 ? (
            <EmptyState title="Nothing completed recently" />
          ) : (
            <ul className="divide-y">
              {recentlyCompleted.issues.map((issue) => (
                <li key={issue.key} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <IssueLink issue={issue} issueKey={issue.key} />
                    <span className="truncate">{issue.summary}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone="success">Done</Badge> {timeAgo(issue.completedAt, now)}
                  </span>
                </li>
              ))}
              {recentlyCompleted.mrs.map((v) => (
                <li key={v.key} className="flex items-center justify-between gap-3 px-4 py-2">
                  <a
                    href={v.mr.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate hover:underline"
                  >
                    !{v.mr.ref.iid} {v.mr.title}
                  </a>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone="success">Merged</Badge> {timeAgo(v.mr.mergedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Up next" description="Ranked suggestions with editable prompts" />
        <CardBody>
          <ComingSoon milestone="M3">
            Feedback to address, failing pipelines, conflicts, reviews requested of you, then your
            next ticket, each with a pre-filled prompt you can run in Claude Code, open in a
            terminal, or copy.
          </ComingSoon>
        </CardBody>
      </Card>
    </div>
  );
}
