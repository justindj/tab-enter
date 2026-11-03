import 'server-only';
import { buildSuggestions, buildWorkspace, deriveConnections } from '@tab-enter/core';
import {
  ensureDemoProfile,
  getActiveProfile,
  getDb,
  getSyncStates,
  getToolStatuses,
  hasPendingJob,
  listIssues,
  listLinks,
  listManualLinks,
  listMergeRequests,
  listProfiles,
  listRecentRuns,
  usageSummary,
} from '@tab-enter/db';
import { cache } from 'react';

// Pages only read SQLite; the worker does all fetching. React's cache() dedupes
// these loads within a single request (layout + page share one read).

export const loadApp = cache(async () => {
  const db = await getDb();
  try {
    await ensureDemoProfile(db);
  } catch (err) {
    if (/no such table/i.test(String(err))) {
      throw new Error(
        'The database has not been set up. Start tab-enter with `pnpm dev`, which runs migrations.',
        {
          cause: err,
        },
      );
    }
    throw err;
  }
  const [profiles, active] = await Promise.all([listProfiles(db), getActiveProfile(db)]);
  if (!active) throw new Error('No profile found.');

  const [issues, mergeRequests, links, manual, syncStates, syncing, tools] = await Promise.all([
    listIssues(db, active.id),
    listMergeRequests(db, active.id),
    listLinks(db, active.id),
    listManualLinks(db, active.id),
    getSyncStates(db, active.id),
    hasPendingJob(db, 'sync', active.id),
    getToolStatuses(db),
  ]);
  const now = new Date();
  const workspace = buildWorkspace({
    issues,
    mergeRequests,
    links,
    manual,
    now,
    retentionDays: active.settings.timeWindows.recentRetentionDays,
  });

  const claude = tools.claude;
  // Demo profiles replay recorded runs; real ones need approval and a working CLI.
  const runBlocker = active.isDemo
    ? null
    : !active.settings.claude.approvedForClient
      ? 'Claude Code is not approved for this client (Settings).'
      : !claude?.installed
        ? 'Claude Code is not installed (Settings).'
        : claude.loggedIn === false
          ? 'Claude Code is logged out: run `claude auth login`.'
          : null;

  const lastSyncedAt = syncStates.reduce<Date | null>(
    (min, s) => (s.lastSyncedAt && (!min || s.lastSyncedAt < min) ? s.lastSyncedAt : min),
    null,
  );
  const syncError = syncStates.find((s) => s.lastError)?.lastError ?? null;

  return {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, isDemo: p.isDemo })),
    active,
    workspace,
    sync: { lastSyncedAt, error: syncError, syncing },
    tools,
    /** Why Run in Claude Code is unavailable, or null when it can run. */
    runBlocker,
    connections: deriveConnections({
      isDemo: active.isDemo,
      settings: active.settings,
      secretNames: active.secretNames,
      syncStates,
      claude: tools.claude,
    }),
    now,
  };
});

export type AppData = Awaited<ReturnType<typeof loadApp>>;

/** Now page extras: suggestions, recent runs and today's usage. */
export const loadNow = cache(async () => {
  const app = await loadApp();
  const db = await getDb();
  const dayStart = new Date(app.now);
  dayStart.setHours(0, 0, 0, 0);
  const [runs, usage] = await Promise.all([
    listRecentRuns(db, app.active.id, { limit: 8 }),
    usageSummary(db, app.active.id, dayStart, app.now),
  ]);
  return {
    ...app,
    suggestions: buildSuggestions(app.workspace, app.active.settings),
    runs,
    usageToday: usage.today,
  };
});
