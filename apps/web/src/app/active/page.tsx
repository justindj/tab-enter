import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { MRStatusBadges } from '@/components/mr-status';
import { IssueLink, MRTable } from '@/components/mr-table';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { cn } from '@/lib/utils';

export default async function ActiveWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const { workspace, active, now } = await loadApp();
  const sprintOnly = scope ? scope !== 'all' : active.settings.jira.sprintOnlyDefault;
  const rows = workspace.activeIssues.filter((v) => !sprintOnly || v.issue.inOpenSprint);

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Active Work</h1>
        <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label="Scope">
          {[
            { label: 'Current sprint', value: 'sprint', on: sprintOnly },
            { label: 'All', value: 'all', on: !sprintOnly },
          ].map((o) => (
            <Link
              key={o.value}
              href={`/active?scope=${o.value}`}
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
          title="My tickets"
          description="Assigned to me and not done. Filters and grouping arrive in M2."
        />
        {rows.length === 0 ? (
          <EmptyState title="No active tickets" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2 font-medium">Ticket</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Merge requests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ issue, mrs }) => (
                <tr key={issue.key} className="border-b align-top last:border-0">
                  <td className="max-w-md px-4 py-2">
                    <IssueLink issue={issue} issueKey={issue.key} />
                    <div>{issue.summary}</div>
                  </td>
                  <td className="px-2 py-2 text-xs">{issue.status}</td>
                  <td className="px-2 py-2 text-xs">{issue.priority ?? '—'}</td>
                  <td className="px-4 py-2">
                    {mrs.length === 0 ? (
                      <Badge tone="muted">No MR</Badge>
                    ) : (
                      <ul className="grid gap-1">
                        {mrs.map((v) => (
                          <li key={v.key} className="flex flex-wrap items-center gap-2">
                            <a
                              href={v.mr.webUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs hover:underline"
                            >
                              !{v.mr.ref.iid}
                            </a>
                            <MRStatusBadges status={v.status} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {workspace.unlinkedMRs.length > 0 && (
        <Card>
          <CardHeader
            title="Unlinked merge requests"
            description="My open MRs with no ticket key in the branch, title or description."
          />
          <MRTable rows={workspace.unlinkedMRs} issuesByKey={workspace.issuesByKey} now={now} />
        </Card>
      )}
    </div>
  );
}
