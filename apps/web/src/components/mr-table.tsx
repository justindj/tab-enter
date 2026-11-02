import type { IssueDetail, MRView } from '@tab-enter/core';
import { MessageSquare, TriangleAlert } from 'lucide-react';
import { MRStatusBadges, PipelineBadge } from '@/components/mr-status';
import { Badge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/format';

export function IssueLink({ issue, issueKey }: { issue?: IssueDetail; issueKey: string }) {
  if (!issue) return <span className="font-mono text-xs">{issueKey}</span>;
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs whitespace-nowrap hover:underline"
    >
      {issue.key}
    </a>
  );
}

export function MRTable({
  rows,
  issuesByKey,
  now,
  showAuthor = false,
}: {
  rows: MRView[];
  issuesByKey: Map<string, IssueDetail>;
  now: Date;
  showAuthor?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-4 py-2 font-medium">Merge request</th>
            <th className="px-2 py-2 font-medium">Ticket</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Pipeline</th>
            <th className="px-2 py-2 font-medium">Approvals</th>
            <th className="px-2 py-2 font-medium">Threads</th>
            <th className="px-4 py-2 text-right font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.key} className="border-b last:border-0 hover:bg-muted/50">
              <td className="max-w-md px-4 py-2">
                <a href={v.mr.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                  {v.mr.title}
                </a>
                <div className="text-xs text-muted-foreground">
                  !{v.mr.ref.iid} · {v.mr.projectPath}
                  {showAuthor && <> · {v.mr.author}</>} · +{v.mr.linesAdded} −{v.mr.linesRemoved}
                </div>
              </td>
              <td className="px-2 py-2 align-top">
                {v.issueKeys.length === 0 ? (
                  <Badge tone="warning" title="No ticket key in branch, title or description">
                    <TriangleAlert className="h-3 w-3" /> Unlinked
                  </Badge>
                ) : (
                  <div className="grid gap-0.5">
                    {v.issueKeys.map((key) => {
                      const issue = issuesByKey.get(key);
                      return (
                        <span key={key} className="flex items-center gap-1.5">
                          <IssueLink issue={issue} issueKey={key} />
                          {issue && (
                            <span className="text-xs text-muted-foreground">{issue.status}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
              </td>
              <td className="px-2 py-2 align-top">
                <MRStatusBadges status={v.status} />
              </td>
              <td className="px-2 py-2 align-top">
                <PipelineBadge status={v.mr.pipelineStatus} />
              </td>
              <td className="px-2 py-2 align-top text-xs tabular-nums">
                {v.mr.approvedBy.length}/{Math.max(1, v.mr.approvalsRequired)}
              </td>
              <td className="px-2 py-2 align-top text-xs">
                {v.mr.unresolvedThreads > 0 ? (
                  <span className="inline-flex items-center gap-1 text-warning">
                    <MessageSquare className="h-3 w-3" /> {v.mr.unresolvedThreads}
                  </span>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </td>
              <td className="px-4 py-2 text-right align-top text-xs text-muted-foreground">
                {timeAgo(v.mr.updatedAt, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
