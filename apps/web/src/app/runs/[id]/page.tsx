import { getRun, listRunEvents, getDb } from '@tab-enter/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import type { AgentEvent } from '@tab-enter/core';
import { BranchActions } from './branch-actions';
import { RunLive } from './run-live';

function lastResult(events: AgentEvent[]): string | null {
  const result = events.findLast((e) => e.type === 'result');
  return result?.type === 'result' ? result.resultText : null;
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { active, workspace, now } = await loadApp();
  const db = await getDb();
  const run = await getRun(db, id);
  if (!run || run.profileId !== active.id) notFound();

  const events = await listRunEvents(db, id, -1, 5000);
  const preset = active.settings.claude.presets[run.preset];
  const issue = run.issueKey ? workspace.issuesByKey.get(run.issueKey) : undefined;

  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <div>
        <Link href="/runs" className="text-xs text-muted-foreground hover:underline">
          ← All runs
        </Link>
        <h1 className="mt-1 text-lg font-semibold">
          {preset?.label ?? run.preset}
          {run.issueKey && (
            <>
              {' · '}
              {issue ? (
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:underline"
                >
                  {run.issueKey}
                </a>
              ) : (
                <span className="font-mono">{run.issueKey}</span>
              )}
            </>
          )}
        </h1>
        <p className="text-xs text-muted-foreground">
          Started {timeAgo(run.createdAt, now)} · requested model {run.modelRequested}
          {run.parentRunId && (
            <>
              {' · continues '}
              <Link href={`/runs/${run.parentRunId}`} className="underline">
                an earlier run
              </Link>
            </>
          )}
        </p>
      </div>

      <Card>
        <CardHeader title="Prompt" />
        <pre className="max-h-72 overflow-auto px-4 py-3 text-xs whitespace-pre-wrap">
          {run.prompt}
        </pre>
      </Card>

      {run.branch &&
        run.status !== 'queued' &&
        run.status !== 'running' &&
        preset?.mode === 'task' && (
          <Card>
            <BranchActions
              runId={run.id}
              branch={run.branch}
              commits={run.diffSummary?.commits ?? []}
              uncommitted={run.diffSummary?.uncommitted ?? 0}
              hasMr={!!run.mrKey}
              allowPush={active.settings.writeActions.gitPush}
              allowOpenMr={active.settings.writeActions.openMergeRequest}
              defaults={{
                title: issue
                  ? `${issue.key} ${issue.summary}`
                  : (run.prompt.split('\n')[0] ?? '').slice(0, 120),
                description: [
                  issue ? `Closes ${issue.key}: ${issue.url}` : '',
                  lastResult(events.map((e) => e.event)) ?? '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
                targetBranch: 'main',
              }}
            />
          </Card>
        )}

      <RunLive
        key={run.id}
        isDemo={active.isDemo}
        softLimitUsd={active.settings.claude.softLimits.perRunUsd ?? null}
        initial={{
          run: {
            id: run.id,
            status: run.status,
            sessionId: run.sessionId,
            modelUsed: run.modelUsed,
            error: run.error,
            cwd: run.cwd,
            branch: run.branch,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            cacheReadTokens: run.cacheReadTokens,
            costUsd: run.costUsd,
            numTurns: run.numTurns,
            cancelRequested: run.cancelRequested,
            diffSummary: run.diffSummary,
            startedAt: run.startedAt?.toISOString() ?? null,
            endedAt: run.endedAt?.toISOString() ?? null,
          },
          events: events.map(({ seq, event }) => ({ seq, event })),
        }}
      />
    </div>
  );
}
