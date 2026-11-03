import { randomUUID } from 'node:crypto';
import {
  LOCAL_USER_ID,
  defaultProfileSettings,
  linkMergeRequest,
  manualOverrideFor,
  mrKey,
  parseProfileSettings,
  type AgentEvent,
  type IssueDetail,
  type Job,
  type JobType,
  type ManualLink,
  type MergeRequest,
  type MRIssueLink,
  type PresetId,
  type ProfileSettings,
  type StoredReview,
  type ToolStatus,
} from '@tab-enter/core';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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
  worktrees,
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
      worktrees,
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

// ------------------------------------------------------------------- theme

export type Theme = 'dark' | 'light' | 'system';
export const THEMES: readonly Theme[] = ['dark', 'light', 'system'];
const THEME_KEY = 'theme';

/** The UI theme, an app-wide (not per-profile) preference. Dark by default. */
export async function getTheme(db: Db, userId = LOCAL_USER_ID): Promise<Theme> {
  const [state] = await db
    .select()
    .from(appState)
    .where(and(eq(appState.userId, userId), eq(appState.key, THEME_KEY)));
  return THEMES.includes(state?.value as Theme) ? (state!.value as Theme) : 'dark';
}

export async function setTheme(db: Db, theme: Theme, userId = LOCAL_USER_ID): Promise<void> {
  await db
    .insert(appState)
    .values({ userId, key: THEME_KEY, value: theme, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appState.userId, appState.key],
      set: { value: theme, updatedAt: new Date() },
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

export interface ClaimFilter {
  /** Only these job types. */
  types?: JobType[];
  /** Any type except these. */
  excludeTypes?: JobType[];
  /** Skip jobs for these profiles (e.g. ones at their parallel-run limit). */
  excludeProfileIds?: string[];
}

/** Atomically take the oldest runnable job matching `filter`. */
export async function claimNextJob(
  db: Db,
  now = new Date(),
  filter: ClaimFilter = {},
): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'queued'),
          lte(jobs.runAfter, now),
          filter.types?.length ? inArray(jobs.type, filter.types) : undefined,
          filter.excludeTypes?.length ? notInArray(jobs.type, filter.excludeTypes) : undefined,
          filter.excludeProfileIds?.length
            ? or(isNull(jobs.profileId), notInArray(jobs.profileId, filter.excludeProfileIds))
            : undefined,
        ),
      )
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

export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ?? null;
}

export async function finishJob(
  db: Db,
  id: string,
  error?: string,
  result?: unknown,
): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: error ? 'failed' : 'done',
      error: error ?? null,
      result: result ?? null,
      finishedAt: new Date(),
    })
    .where(eq(jobs.id, id));
}

// ----------------------------------------------------------- write actions

export type WriteActionRow = typeof writeActionLog.$inferSelect;

/** Log a confirmed write as pending; the worker job then performs it. */
export async function createWriteAction(
  db: Db,
  w: { profileId: string; action: string; target: string; summary: string; payload: unknown },
  userId = LOCAL_USER_ID,
): Promise<string> {
  const id = randomUUID();
  await db.insert(writeActionLog).values({
    id,
    userId,
    ...w,
    status: 'pending',
    createdAt: new Date(),
  });
  return id;
}

export async function getWriteAction(db: Db, id: string): Promise<WriteActionRow | null> {
  const [row] = await db.select().from(writeActionLog).where(eq(writeActionLog.id, id));
  return row ?? null;
}

export async function finishWriteAction(
  db: Db,
  id: string,
  outcome: { result: { url?: string; message?: string } } | { error: string },
): Promise<void> {
  await db
    .update(writeActionLog)
    .set(
      'error' in outcome
        ? { status: 'failed', error: outcome.error, finishedAt: new Date() }
        : { status: 'done', result: outcome.result, finishedAt: new Date() },
    )
    .where(eq(writeActionLog.id, id));
}

export async function listWriteActions(
  db: Db,
  profileId: string,
  limit = 50,
): Promise<WriteActionRow[]> {
  return db
    .select()
    .from(writeActionLog)
    .where(eq(writeActionLog.profileId, profileId))
    .orderBy(desc(writeActionLog.createdAt))
    .limit(limit);
}

// --------------------------------------------------------------- worktrees

export type WorktreeRow = typeof worktrees.$inferSelect;

/** Record what cleanup did (or is asking) for one worktree path. */
export async function upsertWorktree(
  db: Db,
  row: Omit<WorktreeRow, 'id' | 'userId' | 'updatedAt'>,
  userId = LOCAL_USER_ID,
): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(worktrees)
    .values({ id: randomUUID(), userId, updatedAt, ...row })
    .onConflictDoUpdate({
      target: [worktrees.profileId, worktrees.path],
      set: { ...row, updatedAt },
    });
}

export async function listWorktrees(db: Db, profileId: string): Promise<WorktreeRow[]> {
  return db
    .select()
    .from(worktrees)
    .where(eq(worktrees.profileId, profileId))
    .orderBy(desc(worktrees.updatedAt));
}

export async function getWorktree(db: Db, id: string): Promise<WorktreeRow | null> {
  const [row] = await db.select().from(worktrees).where(eq(worktrees.id, id));
  return row ?? null;
}

export async function setWorktreeStatus(
  db: Db,
  id: string,
  status: WorktreeRow['status'],
  error: string | null = null,
): Promise<void> {
  await db
    .update(worktrees)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(worktrees.id, id));
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
    assignedToMe: issue.assignedToMe !== false,
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
  result: { error?: string; tokenExpiresAt?: string | null },
  userId = LOCAL_USER_ID,
): Promise<void> {
  const now = new Date();
  const values = {
    ...(result.error
      ? { lastAttemptAt: now, lastError: result.error }
      : { lastAttemptAt: now, lastSyncedAt: now, lastError: null }),
    ...(result.tokenExpiresAt !== undefined ? { tokenExpiresAt: result.tokenExpiresAt } : {}),
  };
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

/** Store (or, with null, clear) the user's override for one MR/issue pair. */
export async function setManualOverride(
  db: Db,
  profileId: string,
  pair: { mrKey: string; issueKey: string },
  action: 'link' | 'unlink' | null,
  userId = LOCAL_USER_ID,
): Promise<void> {
  const where = and(
    eq(manualLinks.profileId, profileId),
    eq(manualLinks.mrKey, pair.mrKey),
    eq(manualLinks.issueKey, pair.issueKey),
  );
  if (action === null) {
    await db.delete(manualLinks).where(where);
    return;
  }
  const createdAt = new Date();
  await db
    .insert(manualLinks)
    .values({ userId, profileId, ...pair, action, createdAt })
    .onConflictDoUpdate({
      target: [manualLinks.profileId, manualLinks.mrKey, manualLinks.issueKey],
      set: { action, createdAt },
    });
}

export async function getMergeRequest(
  db: Db,
  profileId: string,
  key: string,
): Promise<MergeRequest | null> {
  const [row] = await db
    .select({ data: mergeRequests.data })
    .from(mergeRequests)
    .where(and(eq(mergeRequests.profileId, profileId), eq(mergeRequests.mrKey, key)));
  return row?.data ?? null;
}

/**
 * Link or unlink an MR and a ticket by hand. Stores only the difference from
 * what the linking rules find, then recomputes that MR's links immediately.
 * Returns false when the MR isn't in the local data.
 */
export async function changeManualLink(
  db: Db,
  profileId: string,
  change: { mrKey: string; issueKey: string; linked: boolean },
  keyRegex: string,
): Promise<boolean> {
  const mr = await getMergeRequest(db, profileId, change.mrKey);
  if (!mr) return false;
  const action = manualOverrideFor(mr, change.issueKey, change.linked, keyRegex);
  await setManualOverride(db, profileId, change, action);
  const manual = await listManualLinks(db, profileId);
  await replaceLinksForMr(db, profileId, change.mrKey, linkMergeRequest(mr, { keyRegex, manual }));
  return true;
}

/** Replace one MR's computed links, so a manual change shows without waiting for a sync. */
export async function replaceLinksForMr(
  db: Db,
  profileId: string,
  key: string,
  links: MRIssueLink[],
  userId = LOCAL_USER_ID,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(mrIssueLinks)
      .where(and(eq(mrIssueLinks.profileId, profileId), eq(mrIssueLinks.mrKey, key)));
    if (links.length > 0) {
      await tx
        .insert(mrIssueLinks)
        .values(links.map((l) => ({ userId, profileId, mrKey: key, ...l })));
    }
  });
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

// ----------------------------------------------------------- verification

export type VerificationRow = typeof verificationArtifacts.$inferSelect;

/** A "running" verification row; the worker job fills in the rest. */
export async function createVerification(
  db: Db,
  v: { profileId: string; issueKey: string; mrKey: string | null },
  userId = LOCAL_USER_ID,
): Promise<string> {
  const id = randomUUID();
  await db.insert(verificationArtifacts).values({
    id,
    userId,
    profileId: v.profileId,
    issueKey: v.issueKey,
    mrKey: v.mrKey,
    status: 'running',
    createdAt: new Date(),
  });
  return id;
}

export async function getVerification(db: Db, id: string): Promise<VerificationRow | null> {
  const [row] = await db
    .select()
    .from(verificationArtifacts)
    .where(eq(verificationArtifacts.id, id));
  return row ?? null;
}

export async function updateVerification(
  db: Db,
  id: string,
  patch: Partial<Omit<VerificationRow, 'id' | 'userId' | 'profileId'>>,
): Promise<void> {
  await db.update(verificationArtifacts).set(patch).where(eq(verificationArtifacts.id, id));
}

/** Newest first; optionally for one ticket. */
export async function listVerifications(
  db: Db,
  profileId: string,
  issueKeyFilter?: string,
): Promise<VerificationRow[]> {
  return db
    .select()
    .from(verificationArtifacts)
    .where(
      and(
        eq(verificationArtifacts.profileId, profileId),
        issueKeyFilter ? eq(verificationArtifacts.issueKey, issueKeyFilter) : undefined,
      ),
    )
    .orderBy(desc(verificationArtifacts.createdAt));
}

/** Verifications left "running" by a worker that died. */
export async function failOrphanedVerifications(db: Db): Promise<void> {
  await db
    .update(verificationArtifacts)
    .set({
      status: 'failed',
      error: 'The worker stopped during verification. Run it again.',
      finishedAt: new Date(),
    })
    .where(eq(verificationArtifacts.status, 'running'));
}

// ----------------------------------------------------------- code reviews

export type CodeReviewRow = Omit<typeof codeReviews.$inferSelect, 'result'> & {
  result: StoredReview;
};

export async function saveCodeReview(
  db: Db,
  review: {
    profileId: string;
    mrKey: string;
    reviewedSha: string;
    runId: string;
    result: StoredReview;
  },
  userId = LOCAL_USER_ID,
): Promise<string> {
  const id = randomUUID();
  await db.insert(codeReviews).values({ id, userId, ...review, createdAt: new Date() });
  return id;
}

/** Reviews for one MR (newest first), or the latest per MR for a profile. */
export async function listCodeReviews(
  db: Db,
  profileId: string,
  mrKeyFilter?: string,
): Promise<CodeReviewRow[]> {
  const rows = await db
    .select()
    .from(codeReviews)
    .where(
      and(
        eq(codeReviews.profileId, profileId),
        mrKeyFilter ? eq(codeReviews.mrKey, mrKeyFilter) : undefined,
      ),
    )
    .orderBy(desc(codeReviews.createdAt));
  return rows as CodeReviewRow[];
}

export async function latestCodeReviews(
  db: Db,
  profileId: string,
): Promise<Map<string, CodeReviewRow>> {
  const latest = new Map<string, CodeReviewRow>();
  for (const row of await listCodeReviews(db, profileId)) {
    if (!latest.has(row.mrKey)) latest.set(row.mrKey, row);
  }
  return latest;
}

// ---------------------------------------------------------------- messages

export const MESSAGE_HISTORY_LIMIT = 30;
export type MessageRow = typeof messages.$inferSelect;

/**
 * Save a message the user copied, keeping the newest 30 per profile. Copying
 * the same text again doesn't add a duplicate.
 */
export async function saveMessage(
  db: Db,
  msg: {
    profileId: string;
    kind: MessageRow['kind'];
    format: MessageRow['format'];
    body: string;
    windowStart?: Date | null;
    windowEnd?: Date | null;
  },
  userId = LOCAL_USER_ID,
): Promise<{ id: string; duplicate: boolean }> {
  const [latest] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.profileId, msg.profileId), eq(messages.kind, msg.kind)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (latest && latest.body === msg.body && latest.format === msg.format) {
    return { id: latest.id, duplicate: true };
  }
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(messages).values({
      id,
      userId,
      profileId: msg.profileId,
      kind: msg.kind,
      format: msg.format,
      body: msg.body,
      windowStart: msg.windowStart ?? null,
      windowEnd: msg.windowEnd ?? null,
      createdAt: new Date(),
    });
    const keep = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.profileId, msg.profileId))
      .orderBy(desc(messages.createdAt))
      .limit(MESSAGE_HISTORY_LIMIT);
    await tx.delete(messages).where(
      and(
        eq(messages.profileId, msg.profileId),
        notInArray(
          messages.id,
          keep.map((k) => k.id),
        ),
      ),
    );
  });
  return { id, duplicate: false };
}

export async function listMessages(db: Db, profileId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.profileId, profileId))
    .orderBy(desc(messages.createdAt))
    .limit(MESSAGE_HISTORY_LIMIT);
}

/** When the last daily report was copied, for the "since my last report" window. */
export async function lastDailyReportAt(db: Db, profileId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.profileId, profileId), eq(messages.kind, 'daily-report')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

// -------------------------------------------------------------------- runs

export type RunRow = typeof agentRuns.$inferSelect;

export async function listRecentRuns(
  db: Db,
  profileId: string,
  opts: { limit?: number; issueKey?: string } = {},
): Promise<RunRow[]> {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.profileId, profileId),
        opts.issueKey ? eq(agentRuns.issueKey, opts.issueKey) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(opts.limit ?? 10);
}

export interface NewRun {
  profileId: string;
  preset: PresetId;
  prompt: string;
  modelRequested: string;
  issueKey?: string | null;
  mrKey?: string | null;
  projectId?: string | null;
  /** Continue: resume this run's session in its working directory. */
  parentRunId?: string | null;
}

/**
 * Insert a queued run and the job that executes it. With `enqueue: false` the
 * caller (a worker job such as verification) executes the run itself.
 */
export async function createRun(
  db: Db,
  run: NewRun,
  userId = LOCAL_USER_ID,
  { enqueue = true }: { enqueue?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const parent = run.parentRunId ? await getRun(db, run.parentRunId) : null;
  await db.insert(agentRuns).values({
    id,
    userId,
    profileId: run.profileId,
    preset: run.preset,
    prompt: run.prompt,
    modelRequested: run.modelRequested,
    issueKey: run.issueKey ?? parent?.issueKey ?? null,
    mrKey: run.mrKey ?? parent?.mrKey ?? null,
    projectId: run.projectId ?? parent?.projectId ?? null,
    parentRunId: parent?.id ?? null,
    sessionId: parent?.sessionId ?? null,
    cwd: parent?.cwd ?? null,
    branch: parent?.branch ?? null,
    status: 'queued',
    createdAt: new Date(),
  });
  if (enqueue) {
    await enqueueJob(db, { type: 'agent-run', profileId: run.profileId, runId: id }, { userId });
  }
  return id;
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
  return row ?? null;
}

export async function updateRun(
  db: Db,
  id: string,
  patch: Partial<Omit<RunRow, 'id' | 'userId' | 'profileId'>>,
): Promise<void> {
  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id));
}

/** Queued runs are cancelled at once; running ones are flagged for the worker to stop. */
export async function requestRunCancel(db: Db, id: string): Promise<void> {
  const run = await getRun(db, id);
  if (!run) return;
  if (run.status === 'queued') {
    await updateRun(db, id, { status: 'cancelled', cancelRequested: true, endedAt: new Date() });
  } else if (run.status === 'running') {
    await updateRun(db, id, { cancelRequested: true });
  }
}

export async function appendRunEvents(
  db: Db,
  run: { id: string; profileId: string },
  events: { seq: number; event: AgentEvent }[],
): Promise<void> {
  if (events.length === 0) return;
  const createdAt = new Date();
  for (const chunk of chunks(events)) {
    await db
      .insert(runEvents)
      .values(chunk.map((e) => ({ runId: run.id, profileId: run.profileId, createdAt, ...e })));
  }
}

export async function listRunEvents(
  db: Db,
  runId: string,
  afterSeq = -1,
  limit = 500,
): Promise<{ seq: number; event: AgentEvent; createdAt: Date }[]> {
  return db
    .select({ seq: runEvents.seq, event: runEvents.event, createdAt: runEvents.createdAt })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
}

/** Running runs per profile, for the parallel-run limit. */
export async function countRunningRuns(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ profileId: agentRuns.profileId, n: sql<number>`count(*)` })
    .from(agentRuns)
    .where(eq(agentRuns.status, 'running'))
    .groupBy(agentRuns.profileId);
  return new Map(rows.map((r) => [r.profileId, Number(r.n)]));
}

/** Runs left "running" by a worker that died can't be resumed mid-stream; mark them failed. */
export async function failOrphanedRuns(db: Db): Promise<number> {
  const orphaned = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.status, 'running'));
  for (const { id } of orphaned) {
    await updateRun(db, id, {
      status: 'failed',
      error:
        'The worker stopped while this run was in progress. Continue it to resume the session.',
      endedAt: new Date(),
    });
  }
  return orphaned.length;
}

export interface UsageRow {
  key: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  total: UsageRow;
  today: UsageRow;
  byDay: UsageRow[];
  byPreset: UsageRow[];
  byTicket: UsageRow[];
}

/** Tokens and cost as Claude Code reported them, since `since`. Days are local dates. */
export async function usageSummary(db: Db, profileId: string, since: Date, now = new Date()) {
  const rows = await db
    .select({
      createdAt: agentRuns.createdAt,
      preset: agentRuns.preset,
      issueKey: agentRuns.issueKey,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      cacheReadTokens: agentRuns.cacheReadTokens,
      costUsd: agentRuns.costUsd,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.profileId, profileId), gte(agentRuns.createdAt, since)));

  const empty = (key: string): UsageRow => ({
    key,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  });
  const add = (row: UsageRow, r: (typeof rows)[number]) => {
    row.runs++;
    row.inputTokens += r.inputTokens ?? 0;
    row.outputTokens += r.outputTokens ?? 0;
    row.cacheReadTokens += r.cacheReadTokens ?? 0;
    row.costUsd += r.costUsd ?? 0;
  };
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const group = (keyOf: (r: (typeof rows)[number]) => string) => {
    const map = new Map<string, UsageRow>();
    for (const r of rows) {
      const k = keyOf(r);
      add(map.get(k) ?? map.set(k, empty(k)).get(k)!, r);
    }
    return [...map.values()];
  };

  const total = empty('total');
  const today = empty(day(now));
  for (const r of rows) {
    add(total, r);
    if (day(r.createdAt) === today.key) add(today, r);
  }
  const summary: UsageSummary = {
    total,
    today,
    byDay: group((r) => day(r.createdAt)).sort((a, b) => b.key.localeCompare(a.key)),
    byPreset: group((r) => r.preset).sort((a, b) => b.costUsd - a.costUsd),
    byTicket: group((r) => r.issueKey ?? '(no ticket)').sort((a, b) => b.costUsd - a.costUsd),
  };
  return summary;
}
