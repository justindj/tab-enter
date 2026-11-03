import { defaultProfileSettings, type IssueDetail, type MergeRequest } from '@tab-enter/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client';
import {
  addSecretName,
  changeManualLink,
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
  lastDailyReportAt,
  listLinks,
  listManualLinks,
  listMergeRequests,
  listMessages,
  saveMessage,
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

  it('applies manual link changes immediately and stores only overrides', async () => {
    const p = await createProfile(db, { name: 'P' });
    const regex = '[A-Z][A-Z0-9]+-\\d+';
    await replaceSyncedData(db, p, {
      issues: [issue('ABC-1'), issue('ABC-9')],
      mergeRequests: [{ mr: mr(1), isMine: true, isReviewer: false, needsMyReview: false }],
      links: [{ mrKey: '42!1', links: [{ issueKey: 'ABC-1', source: 'branch' }] }],
    });
    const linksOf = async () =>
      (await listLinks(db, p)).map((l) => `${l.issueKey}:${l.source}`).sort();

    // Unlink the branch match: stored as an "unlink" override.
    await changeManualLink(db, p, { mrKey: '42!1', issueKey: 'ABC-1', linked: false }, regex);
    expect(await linksOf()).toEqual([]);
    expect(await listManualLinks(db, p)).toEqual([
      { mrKey: '42!1', issueKey: 'ABC-1', action: 'unlink' },
    ]);

    // Link a key no rule finds: stored as a "link" override.
    await changeManualLink(db, p, { mrKey: '42!1', issueKey: 'ABC-9', linked: true }, regex);
    expect(await linksOf()).toEqual(['ABC-9:manual']);

    // Re-link the branch match: the override is removed, the rule takes over again.
    await changeManualLink(db, p, { mrKey: '42!1', issueKey: 'ABC-1', linked: true }, regex);
    expect(await linksOf()).toEqual(['ABC-1:branch', 'ABC-9:manual']);
    expect(await listManualLinks(db, p)).toEqual([
      { mrKey: '42!1', issueKey: 'ABC-9', action: 'link' },
    ]);

    // Unlink the manual link: nothing left to store.
    await changeManualLink(db, p, { mrKey: '42!1', issueKey: 'ABC-9', linked: false }, regex);
    expect(await listManualLinks(db, p)).toEqual([]);
    expect(
      await changeManualLink(db, p, { mrKey: '42!404', issueKey: 'ABC-1', linked: true }, regex),
    ).toBe(false);
  });

  it('keeps the newest 30 copied messages per profile, without duplicates', async () => {
    const p = await createProfile(db, { name: 'P' });
    const other = await createProfile(db, { name: 'Q' });
    await saveMessage(db, { profileId: other, kind: 'daily-report', format: 'slack', body: 'q' });
    for (let i = 0; i < 32; i++) {
      await saveMessage(db, { profileId: p, kind: 'daily-report', format: 'slack', body: `r${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(
      await saveMessage(db, { profileId: p, kind: 'daily-report', format: 'slack', body: 'r31' }),
    ).toMatchObject({ duplicate: true });
    const history = await listMessages(db, p);
    expect(history).toHaveLength(30);
    expect(history[0]!.body).toBe('r31');
    expect(history.at(-1)!.body).toBe('r2');
    expect(await listMessages(db, other)).toHaveLength(1);
    expect((await lastDailyReportAt(db, p))?.getTime()).toBe(history[0]!.createdAt.getTime());
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
