import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createGitLabHost,
  createJiraTracker,
  DemoCodeHost,
  DemoIssueTracker,
  type CodeHost,
  type DemoGitLabFixture,
  type DemoJiraFixture,
  type FetchLike,
  type IssueTracker,
} from '@tab-enter/connectors';
import {
  completedSyncDays,
  linkMergeRequest,
  mrKey,
  redactSecrets,
  type CredentialProvider,
  type IssueDetail,
} from '@tab-enter/core';
import { MissingCredentialError, SECRET_NAMES } from '@tab-enter/secrets';
import {
  getProfile,
  listIssues,
  listManualLinks,
  listMergeRequests,
  recordSync,
  replaceSyncedData,
  type Db,
  type Profile,
  type SyncedMR,
} from '@tab-enter/db';

const MAX_REVIEW_TICKETS = 25;

export interface SyncDeps {
  fixturesDir: string;
  /** Required for non-demo profiles. */
  credentials?: CredentialProvider;
  fetch?: FetchLike;
  now?: Date;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function connectorsFor(
  profile: Profile,
  deps: SyncDeps,
  now: Date,
  since: Date,
): Promise<{ tracker: () => IssueTracker; host: () => CodeHost }> {
  if (profile.isDemo) {
    const [jira, gitlab] = await Promise.all([
      readJson<DemoJiraFixture>(path.join(deps.fixturesDir, 'demo/jira.json')),
      readJson<DemoGitLabFixture>(path.join(deps.fixturesDir, 'demo/gitlab.json')),
    ]);
    return {
      tracker: () => new DemoIssueTracker(jira, now),
      host: () => new DemoCodeHost(gitlab, now),
    };
  }
  const { credentials } = deps;
  if (!credentials) throw new Error('The worker has no credential provider.');
  const opts = {
    profileId: profile.id,
    settings: profile.settings,
    credentials,
    completedSince: since,
    fetch: deps.fetch,
    now: () => now,
  };
  // Constructed lazily so a misconfigured Jira doesn't stop GitLab syncing, and vice versa.
  return { tracker: () => createJiraTracker(opts), host: () => createGitLabHost(opts) };
}

async function syncIssues(tracker: IssueTracker, since: Date): Promise<IssueDetail[]> {
  const [active, completed] = await Promise.all([
    tracker.listMyActiveIssues({ sprintOnly: false }),
    tracker.listMyRecentlyCompleted(since),
  ]);
  const seen = new Set<string>();
  const unique = [...active, ...completed].filter((i) => !seen.has(i.key) && seen.add(i.key));
  const details = await Promise.all(unique.map((i) => tracker.getIssue(i.key)));
  // getIssue returns the stored detail; keep the rank and sprint flag from the list call.
  return details.map((d, i) => ({
    ...d,
    rank: unique[i]!.rank,
    inOpenSprint: unique[i]!.inOpenSprint,
  }));
}

async function syncMergeRequests(host: CodeHost, since: Date): Promise<SyncedMR[]> {
  const [mine, merged, reviews] = await Promise.all([
    host.listMyOpenMRs(),
    host.listMyRecentlyMergedMRs(since),
    host.listReviewRequests({ includeCompleted: true }),
  ]);
  const me = await host.getCurrentUser();
  const myName = me.username ?? me.id;

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
      // Same rule as listReviewRequests({ includeCompleted: false }), without a second fetch.
      needsMyReview: mr.state === 'opened' && !mr.approvedBy.includes(myName),
    });
  }
  return [...byKey.values()];
}

function errorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * Pull everything the UI needs for one profile and replace the local copy.
 * Jira and GitLab sync independently: if one fails, its last good data is kept
 * and its error recorded, and the other still updates.
 * Active issues are synced regardless of sprint so the sprint toggle works offline.
 */
export async function syncProfile(db: Db, profileId: string, deps: SyncDeps): Promise<void> {
  const profile = await getProfile(db, profileId);
  if (!profile) return; // deleted while queued
  const now = deps.now ?? new Date();
  const { settings } = profile;
  const since = new Date(now.getTime() - completedSyncDays(settings) * 86_400_000);

  let connectors: Awaited<ReturnType<typeof connectorsFor>>;
  try {
    connectors = await connectorsFor(profile, deps, now, since);
  } catch (err) {
    const message = errorMessage(err);
    await recordSync(db, profileId, 'jira', { error: message });
    await recordSync(db, profileId, 'gitlab', { error: message });
    throw err;
  }

  const [issuesResult, mrsResult] = await Promise.allSettled([
    Promise.resolve().then(() => syncIssues(connectors.tracker(), since)),
    Promise.resolve().then(() => syncMergeRequests(connectors.host(), since)),
  ]);
  // A service the user hasn't set up yet (no token ever saved) isn't a failure.
  // A saved token that has gone missing from the keychain still is.
  const notSetUp = (result: PromiseSettledResult<unknown>, secret: string, hasUrl = true) =>
    result.status === 'rejected' &&
    (!hasUrl ||
      (result.reason instanceof MissingCredentialError && !profile.secretNames.includes(secret)));
  const jiraOff = notSetUp(issuesResult, SECRET_NAMES.jiraToken, !!settings.jira.baseUrl);
  const gitlabOff = notSetUp(mrsResult, SECRET_NAMES.gitlabToken);
  if (jiraOff) await recordSync(db, profileId, 'jira', {});
  if (gitlabOff) await recordSync(db, profileId, 'gitlab', {});
  if (jiraOff && gitlabOff) return;
  if (issuesResult.status === 'rejected' && mrsResult.status === 'rejected') {
    if (!jiraOff)
      await recordSync(db, profileId, 'jira', { error: errorMessage(issuesResult.reason) });
    if (!gitlabOff)
      await recordSync(db, profileId, 'gitlab', { error: errorMessage(mrsResult.reason) });
    throw new Error(
      [
        jiraOff ? '' : `Jira: ${errorMessage(issuesResult.reason)}`,
        gitlabOff ? '' : `GitLab: ${errorMessage(mrsResult.reason)}`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  const issues =
    issuesResult.status === 'fulfilled' ? issuesResult.value : await listIssues(db, profileId);
  const mergeRequests =
    mrsResult.status === 'fulfilled' ? mrsResult.value : await listMergeRequests(db, profileId);

  const manual = await listManualLinks(db, profileId);
  const links = mergeRequests.map(({ mr }) => ({
    mrKey: mrKey(mr.ref),
    links: linkMergeRequest(mr, { keyRegex: settings.keyRegex, manual }),
  }));

  // Tickets of MRs I review (usually someone else's) give review prompts their
  // acceptance criteria. Best effort: a ticket I can't read is just skipped.
  if (issuesResult.status === 'fulfilled') {
    const known = new Set(issues.map((i) => i.key));
    const reviewing = new Set(
      mergeRequests
        .filter((m) => m.isReviewer && m.mr.state === 'opened')
        .map((m) => mrKey(m.mr.ref)),
    );
    const wanted = [
      ...new Set(
        links.filter((l) => reviewing.has(l.mrKey)).flatMap((l) => l.links.map((x) => x.issueKey)),
      ),
    ]
      .filter((k) => !known.has(k))
      .slice(0, MAX_REVIEW_TICKETS);
    if (wanted.length > 0) {
      const tracker = connectors.tracker();
      const extra = await Promise.all(
        wanted.map((key) =>
          tracker
            .getIssue(key)
            .then((issue) => ({ ...issue, assignedToMe: false }))
            .catch(() => null),
        ),
      );
      issues.push(...extra.filter((i) => i !== null));
    }
  }

  await replaceSyncedData(db, profileId, { issues, mergeRequests, links });

  if (!jiraOff)
    await recordSync(
      db,
      profileId,
      'jira',
      issuesResult.status === 'fulfilled' ? {} : { error: errorMessage(issuesResult.reason) },
    );
  // Token expiry (for the header warning); best effort, demo hosts can't say.
  const tokenExpiresAt =
    mrsResult.status === 'fulfilled' && !profile.isDemo
      ? await (connectors.host().getTokenExpiry?.() ?? Promise.resolve(null)).catch(() => null)
      : undefined;
  if (!gitlabOff)
    await recordSync(
      db,
      profileId,
      'gitlab',
      mrsResult.status === 'fulfilled'
        ? { tokenExpiresAt }
        : { error: errorMessage(mrsResult.reason) },
    );
}
