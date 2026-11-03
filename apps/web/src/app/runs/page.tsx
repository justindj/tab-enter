import { getDb, listRecentRuns } from '@tab-enter/db';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { RunList } from '@/components/run-list';
import { Card, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string }>;
}) {
  const { issue } = await searchParams;
  const { active, now } = await loadApp();
  const runs = await listRecentRuns(await getDb(), active.id, { limit: 100, issueKey: issue });
  const presetLabels = Object.fromEntries(
    Object.entries(active.settings.claude.presets).map(([id, p]) => [id, p.label]),
  );
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <h1 className="text-lg font-semibold">Claude Code runs{issue ? ` for ${issue}` : ''}</h1>
      <Card>
        <CardHeader
          title={`Profile “${active.name}”`}
          description={
            issue ? (
              <>
                Runs for {issue}, newest first.{' '}
                <Link href="/runs" className="underline">
                  Show all
                </Link>
              </>
            ) : (
              'The last 100 runs, newest first.'
            )
          }
        />
        {runs.length === 0 ? (
          <EmptyState title="No runs yet">Run a suggestion from the Now page.</EmptyState>
        ) : (
          <RunList runs={runs} now={now} presetLabels={presetLabels} />
        )}
      </Card>
    </div>
  );
}
