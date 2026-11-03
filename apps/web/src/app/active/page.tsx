import type { IssueView } from '@tab-enter/core';
import { loadApp } from '@/lib/data';
import { ActiveWork } from './active-work';

export default async function ActiveWorkPage() {
  const { workspace, active, now } = await loadApp();

  // Descriptions and comments aren't shown here; keep them out of the client payload.
  const views: IssueView[] = workspace.activeIssues.map(({ issue, mrs }) => ({
    issue: { ...issue, description: '', comments: [] },
    mrs,
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <ActiveWork
        key={active.id}
        profileId={active.id}
        views={views}
        unlinked={workspace.unlinkedMRs}
        myOpenMRs={workspace.inFlight}
        sprintDefault={active.settings.jira.sprintOnlyDefault}
        now={now.toISOString()}
      />
    </div>
  );
}
