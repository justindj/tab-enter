import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { IssueLink, MRTable } from '@/components/mr-table';
import { RunList } from '@/components/run-list';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { loadNow } from '@/lib/data';
import { formatTokens, formatUsd, plural, timeAgo } from '@/lib/format';
import { UpNext } from './up-next';

export default async function NowPage() {
  const { workspace, active, now, suggestions, runs, usageToday, runBlocker } = await loadNow();
  const { inFlight, recentlyCompleted, issuesByKey } = workspace;
  const { settings } = active;
  const retention = settings.timeWindows.recentRetentionDays;
  const presetLabels = Object.fromEntries(
    Object.entries(settings.claude.presets).map(([id, p]) => [id, p.label]),
  );
  const projects = settings.gitlab.projects
    .filter((p) => p.localPath)
    .map((p) => ({ id: p.id, label: p.path || p.id }));
  const overDaily =
    settings.claude.softLimits.perDayUsd !== undefined &&
    usageToday.costUsd > settings.claude.softLimits.perDayUsd;

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

      <Card>
        <CardHeader
          title="Up next"
          description={
            runBlocker
              ? `Ranked suggestions with editable prompts. ${runBlocker} Until then, copy the prompts.`
              : active.isDemo
                ? 'Ranked suggestions with editable prompts. Runs in the demo replay recorded output and cost nothing.'
                : 'Ranked suggestions with editable prompts. Runs work in a git worktree per ticket and never push.'
          }
        />
        <UpNext
          suggestions={suggestions}
          runBlocker={runBlocker}
          isDemo={active.isDemo}
          projects={projects}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Claude Code runs"
            description={
              usageToday.runs > 0 ? (
                <span className={overDaily ? 'text-warning' : undefined}>
                  Today: {plural(usageToday.runs, 'run')} ·{' '}
                  {formatTokens(usageToday.inputTokens + usageToday.outputTokens)} ·{' '}
                  {formatUsd(usageToday.costUsd)}
                  {overDaily &&
                    ` (over your ${formatUsd(settings.claude.softLimits.perDayUsd!)} daily limit)`}
                </span>
              ) : (
                'No runs today'
              )
            }
            actions={
              runs.length > 0 && (
                <Link href="/runs" className="text-xs text-muted-foreground hover:underline">
                  All runs
                </Link>
              )
            }
          />
          {runs.length === 0 ? (
            <EmptyState title="No runs yet">
              Run a suggestion from Up next to see it here.
            </EmptyState>
          ) : (
            <RunList runs={runs} now={now} presetLabels={presetLabels} />
          )}
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
    </div>
  );
}
