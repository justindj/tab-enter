import type { RunRow, RunStatus } from '@tab-enter/db';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { formatDuration, formatTokens, formatUsd, timeAgo } from '@/lib/format';

export const RUN_STATUS: Record<
  RunStatus,
  { label: string; tone: 'info' | 'success' | 'danger' | 'muted' | 'warning' }
> = {
  queued: { label: 'Queued', tone: 'muted' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function RunList({
  runs,
  now,
  presetLabels,
}: {
  runs: RunRow[];
  now: Date;
  presetLabels: Record<string, string>;
}) {
  return (
    <ul className="divide-y">
      {runs.map((run) => {
        const end = run.endedAt ?? (run.status === 'running' ? now : null);
        const elapsed = run.startedAt && end ? end.getTime() - run.startedAt.getTime() : null;
        const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
        return (
          <li key={run.id}>
            <Link
              href={`/runs/${run.id}`}
              className="flex items-center gap-3 px-4 py-2 hover:bg-muted/50"
            >
              <RunStatusBadge status={run.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {run.issueKey && <span className="mr-1.5 font-mono text-xs">{run.issueKey}</span>}
                  {presetLabels[run.preset] ?? run.preset}
                  {run.parentRunId && <span className="text-muted-foreground"> (continued)</span>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {run.prompt.split('\n')[0]}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {elapsed !== null && <span className="block">{formatDuration(elapsed)}</span>}
                {run.costUsd !== null ? (
                  <span className="block">
                    {formatTokens(tokens)} · {formatUsd(run.costUsd)}
                  </span>
                ) : (
                  <span className="block">{timeAgo(run.createdAt, now)}</span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
