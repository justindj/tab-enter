import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DemoCodeHost,
  DemoIssueTracker,
  type CodeHost,
  type DemoGitLabFixture,
  type DemoJiraFixture,
  type IssueTracker,
} from '@tab-enter/connectors';
import { linkMergeRequest, mrKey } from '@tab-enter/core';
import {
  getProfile,
  listManualLinks,
  recordSync,
  replaceSyncedData,
  type Db,
  type Profile,
  type SyncedMR,
} from '@tab-enter/db';

export interface SyncDeps {
  fixturesDir: string;
  now?: Date;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function connectorsFor(
  profile: Profile,
  deps: SyncDeps,
  now: Date,
): Promise<{ tracker: IssueTracker; host: CodeHost }> {
  if (profile.isDemo) {
    return {
      tracker: new DemoIssueTracker(
        await readJson<DemoJiraFixture>(path.join(deps.fixturesDir, 'demo/jira.json')),
        now,
      ),
      host: new DemoCodeHost(
        await readJson<DemoGitLabFixture>(path.join(deps.fixturesDir, 'demo/gitlab.json')),
        now,
      ),
    };
  }
  throw new Error(
    'Live Jira and GitLab sync is not built yet (milestone M1). Use the Demo profile for now.',
  );
}

/**
 * Pull everything the UI needs for one profile and replace the local copy.
 * Active issues are synced regardless of sprint so the sprint toggle works offline.
 */
export async function syncProfile(db: Db, profileId: string, deps: SyncDeps): Promise<void> {
  const profile = await getProfile(db, profileId);
  if (!profile) return; // deleted while queued
  const now = deps.now ?? new Date();
  const { settings } = profile;

  try {
    const { tracker, host } = await connectorsFor(profile, deps, now);
    const since = new Date(now.getTime() - settings.timeWindows.recentRetentionDays * 86_400_000);

    const [active, completed, mine, merged, reviews, pendingReviews] = await Promise.all([
      tracker.listMyActiveIssues({ sprintOnly: false }),
      tracker.listMyRecentlyCompleted(since),
      host.listMyOpenMRs(),
      host.listMyRecentlyMergedMRs(since),
      host.listReviewRequests({ includeCompleted: true }),
      host.listReviewRequests({ includeCompleted: false }),
    ]);
    const issues = await Promise.all([...active, ...completed].map((i) => tracker.getIssue(i.key)));

    const pending = new Set(pendingReviews.map((mr) => mrKey(mr.ref)));
    const byKey = new Map<string, SyncedMR>();
    for (const mr of [...mine, ...merged]) {
      byKey.set(mrKey(mr.ref), { mr, isMine: true, isReviewer: false, needsMyReview: false });
    }
    for (const mr of reviews) {
      const key = mrKey(mr.ref);
      byKey.set(key, {
        mr,
        isMine: byKey.get(key)?.isMine ?? false,
        isReviewer: true,
        needsMyReview: pending.has(key),
      });
    }
    const mergeRequests = [...byKey.values()];

    const manual = await listManualLinks(db, profileId);
    const links = mergeRequests.map(({ mr }) => ({
      mrKey: mrKey(mr.ref),
      links: linkMergeRequest(mr, { keyRegex: settings.keyRegex, manual }),
    }));

    await replaceSyncedData(db, profileId, { issues, mergeRequests, links });
    await recordSync(db, profileId, 'jira', {});
    await recordSync(db, profileId, 'gitlab', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSync(db, profileId, 'jira', { error: message });
    await recordSync(db, profileId, 'gitlab', { error: message });
    throw err;
  }
}
