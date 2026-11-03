import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ConnectionStatus } from '@/components/shell/connection-status';
import { ProfileSwitcher, RefreshButton } from '@/components/shell/header-controls';
import { KeyboardShortcuts } from '@/components/shell/keyboard-shortcuts';
import { Sidebar } from '@/components/shell/sidebar';
import { SyncPoller } from '@/components/shell/sync-poller';
import { Badge } from '@/components/ui/badge';
import { loadApp } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import './globals.css';

export const metadata: Metadata = {
  title: 'tab-enter',
  description: 'Your Jira, GitLab and Claude Code work on one screen.',
};

// Every page reads live local state; nothing is statically rendered.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const app = await loadApp();
  const { workspace, active } = app;
  const sprintOnly = active.settings.jira.sprintOnlyDefault;
  const counts = {
    now: workspace.inFlight.length,
    active: workspace.activeIssues.filter((v) => !sprintOnly || v.issue.inOpenSprint).length,
    review: workspace.reviews.filter((v) => v.needsMyReview).length,
  };

  return (
    <html lang="en">
      <body>
        <div className="flex h-screen">
          <Sidebar counts={counts} />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-center justify-between gap-4 border-b px-6 py-2.5">
              <div className="flex items-center gap-3">
                <ProfileSwitcher profiles={app.profiles} activeId={active.id} />
                {active.isDemo && <Badge tone="info">Demo mode: invented data</Badge>}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <ConnectionStatus connections={app.connections} />
                <span className="h-4 border-l" aria-hidden />
                {app.sync.error ? (
                  <span className="text-danger" title={app.sync.error}>
                    Sync failed: {app.sync.error.slice(0, 80)}
                  </span>
                ) : (
                  <span className="whitespace-nowrap">
                    Synced {timeAgo(app.sync.lastSyncedAt, app.now)}
                  </span>
                )}
                <RefreshButton syncing={app.sync.syncing} />
              </div>
            </header>
            <main className="flex-1 overflow-auto px-6 py-5">{children}</main>
          </div>
        </div>
        <KeyboardShortcuts />
        <SyncPoller active={app.sync.syncing || (!app.sync.lastSyncedAt && !app.sync.error)} />
      </body>
    </html>
  );
}
