import { getDb, listRecentRuns } from '@tab-enter/db';
import { EmptyState } from '@/components/empty-state';
import { RunList } from '@/components/run-list';
import { Card, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';

export default async function RunsPage() {
  const { active, now } = await loadApp();
  const runs = await listRecentRuns(await getDb(), active.id, { limit: 100 });
  const presetLabels = Object.fromEntries(
    Object.entries(active.settings.claude.presets).map(([id, p]) => [id, p.label]),
  );
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <h1 className="text-lg font-semibold">Claude Code runs</h1>
      <Card>
        <CardHeader
          title={`Profile “${active.name}”`}
          description="The last 100 runs, newest first."
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
