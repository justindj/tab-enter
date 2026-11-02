import { randomUUID } from 'node:crypto';
import {
  LOCAL_USER_ID,
  defaultProfileSettings,
  mrKey,
  parseProfileSettings,
  type IssueDetail,
  type Job,
  type JobType,
  type ManualLink,
  type MergeRequest,
  type MRIssueLink,
  type ProfileSettings,
  type ToolStatus,
} from '@tab-enter/core';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from './client';
import {
  agentRuns,
  appState,
  codeReviews,
  issues,
  jobs,
  manualLinks,
  mergeRequests,
  messages,
  mrIssueLinks,
  profiles,
  runEvents,
  syncState,
  toolStatus,
  users,
  verificationArtifacts,
  writeActionLog,
} from './schema';

const ACTIVE_PROFILE_KEY = 'activeProfileId';

// ---------------------------------------------------------------- profiles

export type Profile = typeof profiles.$inferSelect;

export async function ensureLocalUser(db: Db): Promise<void> {
  await db
    .insert(users)
    .values({ id: LOCAL_USER_ID, displayName: 'Local user', createdAt: new Date() })
    .onConflictDoNothing();
}

export async function listProfiles(db: Db, userId = LOCAL_USER_ID): Promise<Profile[]> {
  return db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .orderBy(asc(profiles.createdAt));
}

export async function getProfile(db: Db, id: string): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, id));
  return row ? { ...row, settings: parseProfileSettings(row.settings) } : null;
}

export async function createProfile(
  db: Db,
  input: { name: string; isDemo?: boolean; settings?: ProfileSettings; userId?: string },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(profiles).values({
    id,
    userId: input.userId ?? LOCAL_USER_ID,
    name: input.name,
    isDemo: input.isDemo ?? false,
    settings: input.settings ?? defaultProfileSettings(),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateProfile(
  db: Db,
  id: string,
  patch: { name?: string; settings?: ProfileSettings },
): Promise<void> {
  await db
    .update(profiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(profiles.id, id));
}

export async function addSecretName(db: Db, id: string, name: string): Promise<void> {
  const profile = await getProfile(db, id);
  if (!profile || profile.secretNames.includes(name)) return;
  await db
    .update(profiles)
    .set({ secretNames: [...profile.secretNames, name], updatedAt: new Date() })
    .where(eq(profiles.id, id));
}

/**
 * Delete every row belonging to a profile. Returns the keychain entry names
 * the caller must also delete; files are removed by the worker.
 */
export async function deleteProfileRows(db: Db, profileId: string): Promise<string[]> {
  const profile = await getProfile(db, profileId);
  if (!profile) return [];
  await db.transaction(async (tx) => {
    for (const table of [
      issues,
      mergeRequests,
      mrIssueLinks,
      manualLinks,
      syncState,
      agentRuns,
      runEvents,
      verificationArtifacts,
      codeReviews,
      messages,
      writeActionLog,
    ]) {
      await tx.delete(table).where(eq(table.profileId, profileId));
    }
    await tx.delete(jobs).where(and(eq(jobs.profileId, profileId), eq(jobs.status, 'queued')));
    await tx.delete(profiles).where(eq(profiles.id, profileId));
  });
  return profile.secretNames;
}

export async function getActiveProfile(db: Db, userId = LOCAL_USER_ID): Promise<Profile | null> {
  const [state] = await db
    .select()
    .from(appState)
    .where(and(eq(appState.userId, userId), eq(appState.key, ACTIVE_PROFILE_KEY)));
  if (typeof state?.value === 'string') {
    const profile = await getProfile(db, state.value);
    if (profile) return profile;
  }
  const [first] = await listProfiles(db, userId);
  return first ? getProfile(db, first.id) : null;
}

export async function setActiveProfile(
  db: Db,
  profileId: string,
  userId = LOCAL_USER_ID,
): Promise<void> {
  await db
    .insert(appState)
    .values({ userId, key: ACTIVE_PROFILE_KEY, value: profileId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appState.userId, appState.key],
      set: { value: profileId, updatedAt: new Date() },
    });
}

/** First run: create the demo profile so the app is explorable with no credentials. */
export async function ensureDemoProfile(db: Db): Promise<void> {
  await ensureLocalUser(db);
  if ((await listProfiles(db)).length > 0) return;
  const id = await createProfile(db, { name: 'Demo', isDemo: true });
  await setActiveProfile(db, id);
}

// ------------------------------------------------------------ tool status

export async function saveToolStatus(
  db: Db,
  status: ToolStatus,
  userId = LOCAL_USER_ID,
): Promise<void> {
  const checkedAt = new Date(status.checkedAt);
  await db
    .insert(toolStatus)
    .values({ userId, tool: status.tool, status, checkedAt })
    .onConflictDoUpdate({
      target: [toolStatus.userId, toolStatus.tool],
      set: { status, checkedAt },
    });
}

export async function getToolStatuses(
  db: Db,
  userId = LOCAL_USER_ID,
): Promise<Partial<Record<ToolStatus['tool'], ToolStatus>>> {
  const rows = await db.select().from(toolStatus).where(eq(toolStatus.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.tool, r.status]));
}

// -------------------------------------------------------------------- jobs

export type JobRow = typeof jobs.$inferSelect;

export async function enqueueJob(
  db: Db,
  job: Job,
  opts: { runAfter?: Date; userId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(jobs).values({
    id,
    userId: opts.userId ?? LOCAL_USER_ID,
    profileId: 'profileId' in job ? job.profileId : null,
    type: job.type,
    payload: job,
    status: 'queued',
    runAfter: opts.runAfter ?? now,
    createdAt: now,
  });
  return id;
}

export async function hasPendingJob(db: Db, type: JobType, profileId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, type),
        inArray(jobs.status, ['queued', 'running']),
        profileId ? eq(jobs.profileId, profileId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Atomically take the oldest runnable job. */
export async function claimNextJob(db: Db, now = new Date()): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)))
      .orderBy(asc(jobs.createdAt))
      .limit(1);
    if (!next) return null;
    await tx
      .update(jobs)
      .set({ status: 'running', lockedAt: now, attempts: next.attempts + 1 })
      .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued')));
    return { ...next, status: 'running' as const, lockedAt: now, attempts: next.attempts + 1 };
  });
}

export async function finishJob(db: Db, id: string, error?: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: error ? 'failed' : 'done', error: error ?? null, finishedAt: new Date() })
    .where(eq(jobs.id, id));
}

/** Requeue jobs left "running" by a worker that died. */
export async function requeueStaleJobs(db: Db, lockedBefore: Date): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'queued', lockedAt: null })
    .where(and(eq(jobs.status, 'running'), lte(jobs.lockedAt, lockedBefore)));
}

// -------------------------------------------------------------------- sync

export interface SyncedMR {
  mr: MergeRequest;
  isMine: boolean;
  isReviewer: boolean;
  needsMyReview: boolean;
}

/**
 * Replace a profile's synced issues, MRs and computed links in one
 * transaction, so the UI never sees a half-written sync.
 */
export async function replaceSyncedData(
  db: Db,
  profileId: string,
  data: {
    issues: IssueDetail[];
    mergeRequests: SyncedMR[];
    links: { mrKey: string; links: MRIssueLink[] }[];
  },
  userId = LOCAL_USER_ID,
): Promise<void> {
  const now = new Date();
  const issueRows = data.issues.map((issue) => ({
    id: randomUUID(),
    userId,
    profileId,
    key: issue.key,
    statusCategory: issue.statusCategory,
    inOpenSprint: issue.inOpenSprint,
    rank: issue.rank,
    data: issue,
    assignedToMe: true,
    updatedAt: new Date(issue.updatedAt),
    completedAt: issue.completedAt ? new Date(issue.completedAt) : null,
    syncedAt: now,
  }));
  const mrRows = data.mergeRequests.map(({ mr, isMine, isReviewer, needsMyReview }) => ({
    id: randomUUID(),
    userId,
    profileId,
    mrKey: mrKey(mr.ref),
    state: mr.state,
    isMine,
    isReviewer,
    needsMyReview,
    data: mr,
    updatedAt: new Date(mr.updatedAt),
    mergedAt: mr.mergedAt ? new Date(mr.mergedAt) : null,
    syncedAt: now,
  }));
  const linkRows = data.links.flatMap(({ mrKey: key, links }) =>
    links.map((l) => ({ userId, profileId, mrKey: key, issueKey: l.issueKey, source: l.source })),
  );

  await db.transaction(async (tx) => {
    await tx.delete(issues).where(eq(issues.profileId, profileId));
    await tx.delete(mergeRequests).where(eq(mergeRequests.profileId, profileId));
    await tx.delete(mrIssueLinks).where(eq(mrIssueLinks.profileId, profileId));
    for (const chunk of chunks(issueRows)) await tx.insert(issues).values(chunk);
    for (const chunk of chunks(mrRows)) await tx.insert(mergeRequests).values(chunk);
    for (const chunk of chunks(linkRows)) await tx.insert(mrIssueLinks).values(chunk);
  });
}

function chunks<T>(rows: T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export type SyncSource = 'jira' | 'gitlab';

export async function recordSync(
  db: Db,
  profileId: string,
  source: SyncSource,
  result: { error?: string },
  userId = LOCAL_USER_ID,
): Promise<void> {
  const now = new Date();
  const values = result.error
    ? { lastAttemptAt: now, lastError: result.error }
    : { lastAttemptAt: now, lastSyncedAt: now, lastError: null };
  await db
    .insert(syncState)
    .values({ userId, profileId, source, ...values })
    .onConflictDoUpdate({ target: [syncState.profileId, syncState.source], set: values });
}

export async function getSyncStates(db: Db, profileId: string) {
  return db.select().from(syncState).where(eq(syncState.profileId, profileId));
}

export async function listManualLinks(db: Db, profileId: string): Promise<ManualLink[]> {
  const rows = await db.select().from(manualLinks).where(eq(manualLinks.profileId, profileId));
  return rows.map(({ mrKey: key, issueKey, action }) => ({ mrKey: key, issueKey, action }));
}

// ------------------------------------------------------------------ reads

export async function listIssues(db: Db, profileId: string): Promise<IssueDetail[]> {
  const rows = await db
    .select({ data: issues.data })
    .from(issues)
    .where(eq(issues.profileId, profileId))
    .orderBy(asc(issues.rank));
  return rows.map((r) => r.data);
}

export async function listMergeRequests(db: Db, profileId: string): Promise<SyncedMR[]> {
  const rows = await db
    .select({
      data: mergeRequests.data,
      isMine: mergeRequests.isMine,
      isReviewer: mergeRequests.isReviewer,
      needsMyReview: mergeRequests.needsMyReview,
    })
    .from(mergeRequests)
    .where(eq(mergeRequests.profileId, profileId))
    .orderBy(desc(mergeRequests.updatedAt));
  return rows.map((r) => ({
    mr: r.data,
    isMine: r.isMine,
    isReviewer: r.isReviewer,
    needsMyReview: r.needsMyReview,
  }));
}

export async function listLinks(db: Db, profileId: string) {
  return db
    .select({
      mrKey: mrIssueLinks.mrKey,
      issueKey: mrIssueLinks.issueKey,
      source: mrIssueLinks.source,
    })
    .from(mrIssueLinks)
    .where(eq(mrIssueLinks.profileId, profileId));
}

export async function listRecentRuns(db: Db, profileId: string, limit = 10) {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.profileId, profileId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}
