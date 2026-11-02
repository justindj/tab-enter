import { defaultProfileSettings, type IssueDetail, type MergeRequest } from '@tab-enter/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client';
import {
  addSecretName,
  claimNextJob,
  createProfile,
  deleteProfileRows,
  enqueueJob,
  ensureDemoProfile,
  finishJob,
  getActiveProfile,
  getSyncStates,
  hasPendingJob,
  listIssues,
  listLinks,
  listMergeRequests,
  listProfiles,
  recordSync,
  replaceSyncedData,
  requeueStaleJobs,
  setActiveProfile,
} from './repo';
import { createTestDb } from './test-support';

const issue = (key: string): IssueDetail => ({
  key,
  summary: `Issue ${key}`,
  status: 'To Do',
  statusCategory: 'todo',
  priority: 'Medium',
  rank: key,
  issueType: 'Task',
  url: `https://jira.example.test/browse/${key}`,
  inOpenSprint: true,
  updatedAt: '2026-01-15T10:00:00.000Z',
  completedAt: null,
  description: '',
  acceptanceCriteria: [],
  comments: [],
});

const mr = (iid: number): MergeRequest => ({
  ref: { projectId: '42', iid },
  projectPath: 'acme/shop',
  title: `MR ${iid}`,
  description: '',
  sourceBranch: `feature/ABC-${iid}`,
  targetBranch: 'main',
  state: 'opened',
  draft: false,
  author: 'alex.dev',
  webUrl: `https://gitlab.example.test/acme/shop/-/merge_requests/${iid}`,
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
  pipelineStatus: 'success',
  approvedBy: [],
  approvalsRequired: 1,
  unresolvedThreads: 0,
  changesRequested: false,
  reviewers: [],
  linesAdded: 1,
  linesRemoved: 1,
  headSha: 'abc',
  createdAt: '2026-01-15T10:00:00.000Z',
  updatedAt: '2026-01-15T10:00:00.000Z',
  mergedAt: null,
});

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe('profiles', () => {
  it('creates a demo profile on first run, once', async () => {
    await ensureDemoProfile(db);
    await ensureDemoProfile(db);
    const profiles = await listProfiles(db);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: 'Demo', isDemo: true });
    expect((await getActiveProfile(db))?.id).toBe(profiles[0]?.id);
  });

  it('switches the active profile', async () => {
    await ensureDemoProfile(db);
    const id = await createProfile(db, { name: 'Client B', settings: defaultProfileSettings() });
    await setActiveProfile(db, id);
    expect((await getActiveProfile(db))?.name).toBe('Client B');
  });

  it('deletes all of a profile’s data and returns its secret names, leaving others alone', async () => {
    const a = await createProfile(db, { name: 'A' });
    const b = await createProfile(db, { name: 'B' });
    await addSecretName(db, a, 'jira-token');
    await addSecretName(db, a, 'jira-token');
    for (const p of [a, b]) {
      await replaceSyncedData(db, p, {
        issues: [issue('ABC-1')],
        mergeRequests: [{ mr: mr(1), isMine: true, isReviewer: false, needsMyReview: false }],
        links: [{ mrKey: '42!1', links: [{ issueKey: 'ABC-1', source: 'branch' }] }],
      });
      await recordSync(db, p, 'jira', {});
      await enqueueJob(db, { type: 'sync', profileId: p });
    }

    expect(await deleteProfileRows(db, a)).toEqual(['jira-token']);
    expect((await listProfiles(db)).map((p) => p.name)).toEqual(['B']);
    expect(await listIssues(db, a)).toEqual([]);
    expect(await listMergeRequests(db, a)).toEqual([]);
    expect(await getSyncStates(db, a)).toEqual([]);
    expect(await hasPendingJob(db, 'sync', a)).toBe(false);
    expect(await listIssues(db, b)).toHaveLength(1);
    expect(await hasPendingJob(db, 'sync', b)).toBe(true);
  });

  it('falls back to the first profile when the active one is gone', async () => {
    const a = await createProfile(db, { name: 'A' });
    const b = await createProfile(db, { name: 'B' });
    await setActiveProfile(db, b);
    await deleteProfileRows(db, b);
    expect((await getActiveProfile(db))?.id).toBe(a);
  });
});

describe('synced data', () => {
  it('replaces a sync atomically and round-trips JSON data', async () => {
    const p = await createProfile(db, { name: 'P' });
    await replaceSyncedData(db, p, {
      issues: [issue('ABC-2'), issue('ABC-1')],
      mergeRequests: [{ mr: mr(1), isMine: true, isReviewer: false, needsMyReview: false }],
      links: [{ mrKey: '42!1', links: [{ issueKey: 'ABC-1', source: 'branch' }] }],
    });
    await replaceSyncedData(db, p, {
      issues: [issue('ABC-1')],
      mergeRequests: [],
      links: [],
    });
    expect((await listIssues(db, p)).map((i) => i.key)).toEqual(['ABC-1']);
    expect(await listMergeRequests(db, p)).toEqual([]);
    expect(await listLinks(db, p)).toEqual([]);
  });

  it('records sync success and failure', async () => {
    const p = await createProfile(db, { name: 'P' });
    await recordSync(db, p, 'gitlab', { error: 'VPN unreachable' });
    let [state] = await getSyncStates(db, p);
    expect(state).toMatchObject({ lastError: 'VPN unreachable', lastSyncedAt: null });
    await recordSync(db, p, 'gitlab', {});
    [state] = await getSyncStates(db, p);
    expect(state?.lastError).toBeNull();
    expect(state?.lastSyncedAt).toBeInstanceOf(Date);
  });
});

describe('job queue', () => {
  it('claims jobs in order, once, respecting runAfter', async () => {
    await enqueueJob(db, { type: 'detect-tools' });
    await enqueueJob(
      db,
      { type: 'sync', profileId: 'p1' },
      { runAfter: new Date(Date.now() + 60_000) },
    );

    const first = await claimNextJob(db);
    expect(first).toMatchObject({ type: 'detect-tools', status: 'running', attempts: 1 });
    expect(await claimNextJob(db)).toBeNull();

    await finishJob(db, first!.id);
    expect(await hasPendingJob(db, 'detect-tools')).toBe(false);
    expect(await hasPendingJob(db, 'sync', 'p1')).toBe(true);
  });

  it('requeues jobs abandoned by a dead worker', async () => {
    await enqueueJob(db, { type: 'detect-tools' });
    await claimNextJob(db);
    await requeueStaleJobs(db, new Date(Date.now() - 60_000));
    expect(await claimNextJob(db)).toBeNull(); // still fresh: left alone
    await requeueStaleJobs(db, new Date(Date.now() + 1000));
    expect(await claimNextJob(db)).toMatchObject({ type: 'detect-tools', attempts: 2 });
  });
});
